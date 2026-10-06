import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import {
  plcCommunicationRepository,
  type PlcLinkData,
  type PlcLinkMappingRecord,
  type PlcLinkRecord,
} from "@/lib/db/repositories/plc-communication-repository";
import { DomainError } from "@/lib/domain/errors";
import {
  checkLinkMapping,
  checkPlcLink,
  type LinkTag,
  type PlcLinkMappingView,
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
  plcLinkMappingInputSchema,
  plcLinkMappingUpdateSchema,
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
    mappingCount: record._count.mappings,
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
  change: "created" | "updated" | "enabled" | "disabled" | "mapping added" | "mapping changed" | "mapping removed",
): Promise<PlcLinkView> {
  const view = toView(record);
  const mappings = (await plcCommunicationRepository.listMappings(db, record.id)).map((mapping) =>
    toMappingView(mapping, record.pollIntervalMs),
  );
  const snapshot: PlcLinkSnapshot = toPlcLinkSnapshot(view, mappings);
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
  const record = await loadLink(db, actor, linkId);
  const mappings = (await plcCommunicationRepository.listMappings(db, record.id)).map((mapping) =>
    toMappingView(mapping, record.pollIntervalMs),
  );
  return toPlcLinkSnapshot(toView(record), mappings);
}

/** The links a PLC takes part in, for its engineering export. */
export async function listLinksOfPlc(db: PrismaClient, plcId: string): Promise<PlcLinkView[]> {
  return (await plcCommunicationRepository.listPlcLinks(db, plcId)).map(toView);
}

// ───────────────────────────── mappings (TASK-702) ─────────────────────────────

const mappingTag = (tag: PlcLinkMappingRecord["localTag"]) => ({
  tagId: tag.id,
  name: tag.name,
  logicalAddress: tag.logicalAddress,
  area: tag.protocolArea,
  address: tag.protocolAddress,
  dataType: tag.dataType,
  unit: tag.unit,
  scale: tag.scale,
});

function toMappingView(record: PlcLinkMappingRecord, linkIntervalMs: number): PlcLinkMappingView {
  return {
    id: record.id,
    linkId: record.plcCommunicationConnectionId,
    operation: record.operation,
    localTag: mappingTag(record.localTag),
    remoteTag: mappingTag(record.remoteTag),
    updateIntervalMs: record.updateIntervalMs,
    effectiveIntervalMs: record.updateIntervalMs ?? linkIntervalMs,
    enabled: record.enabled,
    quality: null,
  };
}

type TagRow = Awaited<ReturnType<typeof plcCommunicationRepository.findTags>>[number];

const toLinkTag = (tag: TagRow, linkInputs: ReadonlySet<string>): LinkTag => ({
  id: tag.id,
  plcId: tag.plcInstanceId,
  name: tag.name,
  dataType: tag.dataType,
  unit: tag.unit,
  role: tag.role,
  accessMode: tag.accessMode,
  logicalAddress: tag.logicalAddress,
  plcIoPointId: tag.plcIoPointId,
  sourceSignal: tag.sourceSignal,
  protocolArea: tag.protocolArea,
  protocolAddress: tag.protocolAddress,
  moduleBound: tag.moduleMapping !== null,
  linkInput: linkInputs.has(tag.id),
});

/** The values carried over a link, READs first. */
export async function listPlcLinkMappings(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
): Promise<PlcLinkMappingView[]> {
  const record = await loadLink(db, actor, linkId);
  return (await plcCommunicationRepository.listMappings(db, record.id)).map((mapping) =>
    toMappingView(mapping, record.pollIntervalMs),
  );
}

/**
 * Carries one value over a link: a READ fills a tag of the client from a tag of the server,
 * a WRITE sends a value the client's program computes to a writable command or setpoint of
 * the server (ADR-0015). One writer per value: a tag is filled by one READ, a command tag
 * written by one WRITE, across every link. Each mapping is a new version of the link.
 */
export async function addPlcLinkMapping(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  input: unknown,
): Promise<PlcLinkMappingView> {
  const data = parseInput(plcLinkMappingInputSchema, input);
  const record = await loadLink(db, actor, linkId);
  const tags = await plcCommunicationRepository.findTags(db, [data.localTagId, data.remoteTagId]);
  const local = tags.find((tag) => tag.id === data.localTagId);
  const remote = tags.find((tag) => tag.id === data.remoteTagId);
  if (!local || !remote) throw notFound("tag");
  const linkInputs = await plcCommunicationRepository.linkInputTagIds(db, [local.plcInstanceId]);
  checkLinkMapping(data.operation, toLinkTag(local, linkInputs), toLinkTag(remote, new Set()), {
    clientPlcId: record.clientPlcInstanceId,
    serverPlcId: record.serverPlcInstanceId,
  });

  const created = await db.$transaction(async (transaction) => {
    await plcCommunicationRepository.lockLink(transaction, record.id);
    const taken = (
      await plcCommunicationRepository.findTagUse(transaction, data.operation === "READ" ? local.id : remote.id)
    ).find((use) => use.operation === data.operation);
    if (taken) {
      throw new DomainError(
        "OCCUPIED_ENDPOINT",
        data.operation === "READ"
          ? `${local.name} is already filled by a PLC link.`
          : `${remote.name} is already written by a PLC link.`,
        { rule: "plc-link-one-writer", tag: data.operation === "READ" ? local.name : remote.name },
      );
    }
    const mapping = await plcCommunicationRepository.createMapping(transaction, {
      linkId: record.id,
      operation: data.operation,
      localTagId: local.id,
      remoteTagId: remote.id,
      updateIntervalMs: data.updateIntervalMs ?? null,
      enabled: data.enabled ?? true,
    });
    return { mapping, link: await plcCommunicationRepository.bumpVersion(transaction, record.id) };
  });
  await version(db, actor, created.link, "mapping added");
  return toMappingView(created.mapping, created.link.pollIntervalMs);
}

/** Changes a mapping's interval or state; a new version of the link. */
export async function updatePlcLinkMapping(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  mappingId: string,
  input: unknown,
): Promise<PlcLinkMappingView> {
  const data = parseInput(plcLinkMappingUpdateSchema, input);
  const record = await loadLink(db, actor, linkId);
  const existing = isUuid(mappingId) ? await plcCommunicationRepository.findMapping(db, record.id, mappingId) : null;
  if (!existing) throw notFound("mapping");
  const updated = await db.$transaction(async (transaction) => {
    await plcCommunicationRepository.lockLink(transaction, record.id);
    const mapping = await plcCommunicationRepository.updateMapping(transaction, existing.id, data);
    return { mapping, link: await plcCommunicationRepository.bumpVersion(transaction, record.id) };
  });
  await version(db, actor, updated.link, "mapping changed");
  return toMappingView(updated.mapping, updated.link.pollIntervalMs);
}

/** Stops carrying a value. The tags stay as they are; a new version of the link. */
export async function removePlcLinkMapping(
  db: PrismaClient,
  actor: Actor,
  linkId: string,
  mappingId: string,
): Promise<void> {
  const record = await loadLink(db, actor, linkId);
  const existing = isUuid(mappingId) ? await plcCommunicationRepository.findMapping(db, record.id, mappingId) : null;
  if (!existing) throw notFound("mapping");
  const link = await db.$transaction(async (transaction) => {
    await plcCommunicationRepository.lockLink(transaction, record.id);
    await plcCommunicationRepository.deleteMapping(transaction, existing.id);
    return plcCommunicationRepository.bumpVersion(transaction, record.id);
  });
  await version(db, actor, link, "mapping removed");
}
