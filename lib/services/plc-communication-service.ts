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
import { hasCapability, isProgrammableController } from "@/lib/domain/device-capabilities";
import type { CommunicationLinkView, LinkTagOption, PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import {
  checkLinkMapping,
  linkEndRefusal,
  type PlcLinkOperation,
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
import type { EventBus } from "@/lib/events/bus";
import { readModbus } from "@/lib/protocols/modbus/client";
import type { ModbusMasterDevice } from "@/lib/runtimes/openplc/bundle";
import { publishedModbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import type { LinkCheck, LinkHealth, PlcLinkMonitorRuntime } from "@/lib/runtimes/plc-link/monitor";
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

/** A link's mappings without an owner check, for the engineering export of a PLC already loaded. */
export async function listPlcLinkMappingsOf(db: PrismaClient, linkId: string): Promise<PlcLinkMappingView[]> {
  const record = await db.plcCommunicationConnection.findUnique({
    where: { id: linkId },
    select: { pollIntervalMs: true },
  });
  return (await plcCommunicationRepository.listMappings(db, linkId)).map((mapping) =>
    toMappingView(mapping, record?.pollIntervalMs ?? 1000),
  );
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
  scale: tag.scale,
  offset: tag.offset,
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
  /** When given, each mapping carries its link's live quality (TASK-703). */
  monitor?: PlcLinkMonitorRuntime,
): Promise<PlcLinkMappingView[]> {
  const record = await loadLink(db, actor, linkId);
  const quality = monitor?.health(record.factoryId).find((health) => health.linkId === record.id)?.quality ?? null;
  return (await plcCommunicationRepository.listMappings(db, record.id)).map((mapping) => ({
    ...toMappingView(mapping, record.pollIntervalMs),
    quality: mapping.enabled ? quality : null,
  }));
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

// ───────────────────────────── runtime (TASK-703) ─────────────────────────────

/** What a client PLC's runtime is deployed with for its links, and which link versions that is. */
export type ModbusMasterPlan = {
  devices: ModbusMasterDevice[];
  links: Array<{ linkId: string; configVersion: number }>;
};

/**
 * The Modbus master configuration of a PLC that is the client of links (TASK-703): one
 * device per enabled link — the server by its service name on the factory network — with a
 * point per enabled mapping. Deployed with the PLC's program; the PLC's own runtime then
 * exchanges the values, inside the factory network, without Z-Factory in the path.
 */
export async function modbusMasterPlan(db: PrismaClient, clientPlcId: string): Promise<ModbusMasterPlan> {
  const links = (await plcCommunicationRepository.listPlcLinks(db, clientPlcId)).filter(
    (link) => link.clientPlcInstanceId === clientPlcId && link.enabled,
  );
  const devices: ModbusMasterDevice[] = [];
  for (const link of links) {
    const points = (await plcCommunicationRepository.listMappings(db, link.id))
      .filter((mapping) => mapping.enabled && mapping.remoteTag.protocolArea !== null)
      .flatMap((mapping) =>
        mapping.remoteTag.protocolArea !== null &&
        mapping.remoteTag.protocolAddress !== null &&
        mapping.localTag.logicalAddress
          ? [
              {
                operation: mapping.operation,
                remoteArea: mapping.remoteTag.protocolArea,
                remoteAddress: mapping.remoteTag.protocolAddress,
                localAddress: mapping.localTag.logicalAddress,
                cycleTimeMs: mapping.updateIntervalMs ?? link.pollIntervalMs,
              },
            ]
          : [],
      );
    if (points.length === 0) continue;
    devices.push({
      name: `link-${link.id.slice(-12)}`,
      host: link.serverHost,
      port: link.serverPort,
      unitId: link.unitId,
      timeoutMs: Math.min(1000, link.pollIntervalMs),
      points,
    });
  }
  return { devices, links: links.map((link) => ({ linkId: link.id, configVersion: link.configVersion })) };
}

export type PlcLinkDeps = {
  db: PrismaClient;
  bus?: EventBus;
  monitor: PlcLinkMonitorRuntime;
  /** How often the links are checked, in milliseconds. */
  pollMs?: number;
};

/** `payload.link` of the connection events the link monitor records. */
export const PLC_LINK_EVENT_LINK = "plc-link";

/**
 * How each enabled link of the factory is doing, as far as Z-Factory can see without being in
 * the path: STALE when the client's runtime does not run the link's current version (it is not
 * running, or was deployed before the last change), DISCONNECTED when the server does not
 * answer on Modbus, GOOD otherwise. The probe reads the server's first mapped register from the
 * host; the exchange itself runs between the two containers on the factory network.
 */
async function checkLinks(db: PrismaClient, factoryId: string): Promise<LinkCheck[]> {
  const links = (await plcCommunicationRepository.listLinks(db, factoryId)).filter((link) => link.enabled);
  const checks: LinkCheck[] = [];
  for (const link of links) {
    const view = toView(link);
    const client = view.client === "SOURCE" ? view.source : view.target;
    const server = view.client === "SOURCE" ? view.target : view.source;
    const base = { linkId: link.id, clientPlcId: client.plcId, clientName: client.name, serverName: server.name };
    const deployed = (await plcCommunicationRepository.deployedLinkVersions(db, factoryId, client.plcId)).get(link.id);
    if (client.runtimeStatus !== "RUNNING") {
      checks.push({ ...base, quality: "STALE", reason: `${client.name} is not running.` });
      continue;
    }
    if (deployed !== link.configVersion) {
      checks.push({
        ...base,
        quality: "STALE",
        reason: `${client.name} runs ${deployed ? `version ${deployed}` : "no version"} of the link; deploy its program to apply version ${link.configVersion}.`,
      });
      continue;
    }
    const port = await plcCommunicationRepository.findModbusPort(db, server.plcId);
    const [probe] = await plcCommunicationRepository.listMappings(db, link.id);
    const answered =
      port?.hostPort && server.runtimeStatus === "RUNNING"
        ? await readModbus(
            publishedModbusEndpoint(port.bindAddress, port.hostPort),
            probe?.remoteTag.protocolArea ?? "HOLDING_REGISTER",
            probe?.remoteTag.protocolAddress ?? 0,
            1,
          ).then(
            () => true,
            () => false,
          )
        : false;
    checks.push(
      answered
        ? { ...base, quality: "GOOD", reason: null }
        : { ...base, quality: "DISCONNECTED", reason: `${server.name} does not answer on Modbus.` },
    );
  }
  return checks;
}

/** Starts watching the factory's links; a change of quality is recorded once as CONNECTION_DOWN/UP. */
export function startPlcLinkMonitor(deps: PlcLinkDeps, factoryId: string, options: { autoTick?: boolean } = {}): void {
  deps.monitor.start(factoryId, {
    evaluate: () => checkLinks(deps.db, factoryId),
    pollMs: deps.pollMs,
    autoTick: options.autoTick,
    onChanges: async (changes) => {
      const events = changes
        // The first look at a link that is fine is not news.
        .filter((change) => change.previous !== null || change.current.quality !== "GOOD")
        .map((change) => ({
          type: change.current.quality === "GOOD" ? "CONNECTION_UP" : "CONNECTION_DOWN",
          factoryId,
          deviceId: change.current.clientPlcId,
          severity: change.current.quality === "DISCONNECTED" ? ("WARNING" as const) : ("INFO" as const),
          payload: {
            link: PLC_LINK_EVENT_LINK,
            linkId: change.current.linkId,
            to: change.current.serverName,
            state: change.current.quality,
            ...(change.current.reason ? { message: change.current.reason } : {}),
          },
        }));
      if (events.length > 0) await recordEvents(deps, events);
    },
  });
}

export function stopPlcLinkMonitor(deps: PlcLinkDeps, factoryId: string): void {
  deps.monitor.stop(factoryId);
}

export type PlcLinkHealthView = LinkHealth;

/** The last known health of the factory's links; empty while they are not watched. */
export async function getPlcLinkHealth(
  deps: PlcLinkDeps,
  actor: Actor,
  factoryId: string,
): Promise<PlcLinkHealthView[]> {
  const factory = await getFactory(deps.db, actor, factoryId);
  return deps.monitor.health(factory.id);
}

// ───────────────────────────── the Communication screen (TASK-704) ─────────────────────────────

/**
 * Everything the PLC's Communication screen shows: the PLCs it can link to, its links in
 * either role with their health, deployed version and mappings, and — where it is the
 * client — every tag of both ends as a picker option with the reason it cannot be used.
 */
export async function getPlcCommunicationView(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  monitor?: PlcLinkMonitorRuntime,
): Promise<PlcCommunicationView> {
  const plc = await loadPlc(db, actor, plcId, "this");
  const peers = (await plcCommunicationRepository.listFactoryControllers(db, plc.factoryId))
    .filter((candidate) => candidate.id !== plc.id && isProgrammableController(candidate.deviceModel))
    .map((candidate) => ({
      plcId: candidate.id,
      name: candidate.name,
      runtimeStatus: candidate.runtimeStatus,
      servesModbus: hasCapability(candidate.deviceModel, "MODBUS_SERVER"),
    }));
  const health = new Map((monitor?.health(plc.factoryId) ?? []).map((entry) => [entry.linkId, entry]));
  const deployed = await plcCommunicationRepository.deployedLinkVersions(db, plc.factoryId, plc.id);
  const records = await plcCommunicationRepository.listPlcLinks(db, plc.id);

  // Tags a link already fills or writes, across every link: the picker marks them taken.
  const linkInputs = await plcCommunicationRepository.linkInputTagIds(db, [
    plc.id,
    ...records.map((record) => record.serverPlcInstanceId),
  ]);
  const writtenRemote = new Set(
    (
      await plcCommunicationRepository.listWrittenTagIds(
        db,
        records.map((record) => record.serverPlcInstanceId),
      )
    ).map((row) => row.remoteTagId),
  );

  const links: CommunicationLinkView[] = [];
  for (const record of records) {
    const view = toView(record);
    const role = record.clientPlcInstanceId === plc.id ? ("client" as const) : ("server" as const);
    const peer = view.source.plcId === plc.id ? view.target : view.source;
    const entry = health.get(record.id);
    const clientDeployed =
      role === "client"
        ? deployed.get(record.id)
        : (await plcCommunicationRepository.deployedLinkVersions(db, plc.factoryId, record.clientPlcInstanceId)).get(
            record.id,
          );
    const mappings = (await plcCommunicationRepository.listMappings(db, record.id)).map((mapping) => ({
      ...toMappingView(mapping, record.pollIntervalMs),
      quality: mapping.enabled && entry ? entry.quality : null,
    }));

    let options: CommunicationLinkView["options"] = null;
    if (role === "client") {
      const [localTags, remoteTags] = await Promise.all([
        plcCommunicationRepository.listPlcTags(db, record.clientPlcInstanceId),
        plcCommunicationRepository.listPlcTags(db, record.serverPlcInstanceId),
      ]);
      const option = (tag: TagRow, refusal: string | null): LinkTagOption => ({
        tagId: tag.id,
        name: tag.name,
        logicalAddress: tag.logicalAddress,
        dataType: tag.dataType,
        unit: tag.unit,
        scale: tag.scale,
        refusal,
      });
      const build = (operation: PlcLinkOperation) => ({
        local: localTags.map((tag) => {
          const linkTag = toLinkTag(tag, linkInputs);
          const taken = operation === "READ" && linkInputs.has(tag.id) ? "already filled by a link" : null;
          return option(tag, taken ?? linkEndRefusal(operation, "local", linkTag));
        }),
        remote: remoteTags.map((tag) => {
          const taken = operation === "WRITE" && writtenRemote.has(tag.id) ? "already written by a link" : null;
          return option(tag, taken ?? linkEndRefusal(operation, "remote", toLinkTag(tag, new Set())));
        }),
      });
      options = { READ: build("READ"), WRITE: build("WRITE") };
    }

    links.push({
      link: view,
      role,
      peer: { plcId: peer.plcId, name: peer.name },
      health: entry
        ? { quality: entry.quality, reason: entry.reason, since: entry.since, checkedAt: entry.checkedAt }
        : null,
      deployedVersion: clientDeployed ?? null,
      mappings,
      options,
    });
  }
  return {
    plcId: plc.id,
    factoryId: plc.factoryId,
    peers,
    links,
    watched: monitor?.isRunning(plc.factoryId) ?? false,
  };
}
