import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import {
  plcCommunicationRepository,
  type PlcLinkData,
  type PlcLinkRecord,
} from "@/lib/db/repositories/plc-communication-repository";
import { DomainError } from "@/lib/domain/errors";
import {
  checkPlcLink,
  type LinkEndpointPlc,
  PLC_LINK_DEFAULTS,
  type PlcLinkClient,
  type PlcLinkProtocol,
  type PlcLinkSnapshot,
  type PlcLinkView,
  plcLinkServerHost,
  toPlcLinkSnapshot,
} from "@/lib/domain/plc-communication";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { parseInput } from "@/lib/validation/parse";
import {
  type PlcLinkInput,
  plcLinkInputSchema,
  type PlcLinkUpdate,
  plcLinkUpdateSchema,
} from "@/lib/validation/plc-communication";
import { recordEvents } from "./event-service";
import { getFactory } from "./factory-service";

/**
 * PLC-to-PLC communication links (TASK-701, docs/architecture.md → PLC-to-PLC
 * communication). A link is configuration: which two PLCs of a factory talk, who is the
 * client, where the server listens on the factory network, and what the link is for. Every
 * change is a new configuration version of the link. Mappings over a link are TASK-702; the
 * runtime that drives it is TASK-703. Nothing here starts a container or writes a tag.
 */

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);
const isUuid = (value: string) => z.uuid().safeParse(value).success;

function toView(record: PlcLinkRecord): PlcLinkView {
  const end = (plc: PlcLinkRecord["sourcePlc"]) => ({
    plcId: plc.deviceInstance.id,
    name: plc.deviceInstance.name,
    runtimeStatus: plc.deviceInstance.runtimeStatus,
  });
  return {
    id: record.id,
    factoryId: record.factoryId,
    relationship: record.relationship,
    protocol: record.protocol as PlcLinkProtocol,
    source: end(record.sourcePlc),
    target: end(record.targetPlc),
    client: record.clientPlcInstanceId === record.sourcePlcInstanceId ? "SOURCE" : "TARGET",
    clientPlcId: record.clientPlcInstanceId,
    serverPlcId: record.serverPlcInstanceId,
    serverHost: record.serverHost,
    serverPort: record.serverPort,
    unitId: record.unitId,
    pollIntervalMs: record.pollIntervalMs,
    enabled: record.enabled,
    configVersion: record.configVersion,
    mappingCount: 0,
    createdAt: record.createdAt.toISOString(),
    updatedAt: record.updatedAt.toISOString(),
  };
}

async function loadLink(db: PrismaClient, actor: Actor, linkId: string): Promise<PlcLinkRecord> {
  const record = isUuid(linkId) ? await plcCommunicationRepository.findLink(db, actor.ownerId, linkId) : null;
  if (!record) throw notFound("PLC link");
  return record;
}

async function loadPlc(db: PrismaClient, actor: Actor, plcId: string, what: string): Promise<LinkEndpointPlc> {
  const plc = isUuid(plcId) ? await plcCommunicationRepository.findPlc(db, actor.ownerId, plcId) : null;
  if (!plc) throw new DomainError("NOT_FOUND", `The ${what} PLC does not exist.`, { field: `${what}PlcId` });
  return { id: plc.id, factoryId: plc.factoryId, name: plc.name, model: plc.deviceModel };
}

/** Which PLC serves and which calls, from the two ends and the chosen client end. */
function roles(source: LinkEndpointPlc, target: LinkEndpointPlc, client: PlcLinkClient) {
  const clientPlc = client === "SOURCE" ? source : target;
  const serverPlc = client === "SOURCE" ? target : source;
  return { clientPlc, serverPlc, serverHost: plcLinkServerHost(serverPlc.name) };
}

/** Stores the link's current configuration as its next version and records the event. */
async function version(
  db: PrismaClient,
  actor: Actor,
  record: PlcLinkRecord,
  change: "created" | "updated" | "enabled" | "disabled",
): Promise<PlcLinkView> {
  const view = toView(record);
  const snapshot: PlcLinkSnapshot = toPlcLinkSnapshot(view);
  await plcCommunicationRepository.recordVersion(db, {
    factoryId: record.factoryId,
    linkId: record.id,
    version: record.configVersion,
    createdBy: actor.ownerId,
    snapshotJson: JSON.parse(JSON.stringify(snapshot)) as Prisma.InputJsonObject,
  });
  await recordEvents({ db }, [
    {
      type: "PLC_LINK_CHANGED",
      factoryId: record.factoryId,
      deviceId: record.sourcePlcInstanceId,
      payload: {
        action: change,
        link: `${view.source.name} ${view.relationship.toLowerCase().replace("_", " ")} ${view.target.name}`,
        version: view.configVersion,
        to: view.target.name,
      },
    },
  ]);
  return view;
}

/** The links of a factory, oldest first. */
export async function listPlcLinks(db: PrismaClient, actor: Actor, factoryId: string): Promise<PlcLinkView[]> {
  const factory = await getFactory(db, actor, factoryId);
  return (await plcCommunicationRepository.listLinks(db, factory.id)).map(toView);
}

export async function getPlcLink(db: PrismaClient, actor: Actor, linkId: string): Promise<PlcLinkView> {
  return toView(await loadLink(db, actor, linkId));
}

/**
 * Links two PLCs of a factory. Refused: a PLC with itself, PLCs of different factories, a
 * device that is not a programmable controller, a server whose model does not serve the
 * protocol, and a second link of the same pair, direction and protocol.
 */
export async function createPlcLink(db: PrismaClient, actor: Actor, input: unknown): Promise<PlcLinkView> {
  const data: PlcLinkInput = parseInput(plcLinkInputSchema, input);
  const factory = await getFactory(db, actor, data.factoryId);
  const [source, target] = await Promise.all([
    loadPlc(db, actor, data.sourcePlcId, "source"),
    loadPlc(db, actor, data.targetPlcId, "target"),
  ]);
  if (source.factoryId !== factory.id) {
    throw new DomainError("INVARIANT", `${source.name} is not in this factory.`, { rule: "plc-link-factory" });
  }
  checkPlcLink(source, target, data.protocol, data.client);
  const { clientPlc, serverPlc, serverHost } = roles(source, target, data.client);
  const row: PlcLinkData = {
    factoryId: factory.id,
    sourcePlcInstanceId: source.id,
    targetPlcInstanceId: target.id,
    relationship: data.relationship,
    protocol: data.protocol,
    clientPlcInstanceId: clientPlc.id,
    serverPlcInstanceId: serverPlc.id,
    serverHost,
    serverPort: data.serverPort ?? PLC_LINK_DEFAULTS.serverPort,
    unitId: data.unitId ?? PLC_LINK_DEFAULTS.unitId,
    pollIntervalMs: data.pollIntervalMs ?? PLC_LINK_DEFAULTS.pollIntervalMs,
    enabled: data.enabled ?? true,
  };
  const created = await plcCommunicationRepository.createLink(db, row);
  return version(db, actor, created, "created");
}

/** Changes the relationship, the client end, the endpoint or the state; a new version either way. */
export async function updatePlcLink(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  input: unknown,
): Promise<PlcLinkView> {
  const data: PlcLinkUpdate = parseInput(plcLinkUpdateSchema, input);
  const record = await loadLink(db, actor, linkId);
  const [source, target] = await Promise.all([
    loadPlc(db, actor, record.sourcePlcInstanceId, "source"),
    loadPlc(db, actor, record.targetPlcInstanceId, "target"),
  ]);
  const client: PlcLinkClient =
    data.client ?? (record.clientPlcInstanceId === record.sourcePlcInstanceId ? "SOURCE" : "TARGET");
  checkPlcLink(source, target, record.protocol as PlcLinkProtocol, client);
  const { clientPlc, serverPlc, serverHost } = roles(source, target, client);
  const updated = await plcCommunicationRepository.updateLink(db, record.id, {
    relationship: data.relationship,
    clientPlcInstanceId: clientPlc.id,
    serverPlcInstanceId: serverPlc.id,
    // Recomputed on every change: the server's name on the network follows the device's name.
    serverHost,
    serverPort: data.serverPort,
    unitId: data.unitId,
    pollIntervalMs: data.pollIntervalMs,
    enabled: data.enabled,
  });
  const change =
    data.enabled !== undefined && data.enabled !== record.enabled ? (data.enabled ? "enabled" : "disabled") : "updated";
  return version(db, actor, updated, change);
}

/** Enables or disables the link without touching its endpoint. */
export function setPlcLinkEnabled(db: PrismaClient, actor: Actor, linkId: string, enabled: boolean) {
  return updatePlcLink(db, actor, linkId, { enabled });
}

/** Removes the link. Its configuration versions stay as history; the PLCs are not changed. */
export async function deletePlcLink(db: PrismaClient, actor: Actor, linkId: string): Promise<void> {
  const record = await loadLink(db, actor, linkId);
  await plcCommunicationRepository.deleteLink(db, record.id);
  await recordEvents({ db }, [
    {
      type: "PLC_LINK_CHANGED",
      factoryId: record.factoryId,
      deviceId: record.sourcePlcInstanceId,
      payload: {
        action: "removed",
        link: `${record.sourcePlc.deviceInstance.name} → ${record.targetPlc.deviceInstance.name}`,
        version: record.configVersion,
      },
    },
  ]);
}

export type PlcLinkVersion = { version: number; createdAt: string; createdBy: string; snapshot: PlcLinkSnapshot };

/** The link's configuration versions, newest first. */
export async function listPlcLinkVersions(db: PrismaClient, actor: Actor, linkId: string): Promise<PlcLinkVersion[]> {
  const record = await loadLink(db, actor, linkId);
  return (await plcCommunicationRepository.listVersions(db, record.factoryId, record.id)).map((row) => ({
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    snapshot: row.snapshotJson as PlcLinkSnapshot,
  }));
}

/** The link as a document another installation reads: PLCs by name, roles, endpoint, mappings. */
export async function exportPlcLink(db: PrismaClient, actor: Actor, linkId: string): Promise<PlcLinkSnapshot> {
  return toPlcLinkSnapshot(toView(await loadLink(db, actor, linkId)));
}

/** The links a PLC takes part in, for its engineering export. */
export async function listLinksOfPlc(db: PrismaClient, plcId: string): Promise<PlcLinkView[]> {
  return (await plcCommunicationRepository.listPlcLinks(db, plcId)).map(toView);
}
