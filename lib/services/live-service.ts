import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { eventRepository } from "@/lib/db/repositories/event-repository";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { simulationRepository } from "@/lib/db/repositories/simulation-repository";
import { PLC_LINK_ALARM, TAG_ALARM_PREFIX, TAG_MONITOR_LINK } from "@/lib/domain/alarms";
import { DomainError } from "@/lib/domain/errors";
import {
  DEFAULT_STALE_AFTER_MS,
  type LiveDeviceState,
  type LiveMessage,
  type LiveSnapshot,
  type LiveTagReading,
} from "@/lib/domain/live";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { TagDataType, TagRole } from "@/lib/domain/tag";
import { isExternallyWritable, type TagAuthority, tagAuthority } from "@/lib/domain/tag-authority";
import type { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { readModbus } from "@/lib/protocols/modbus/client";
import type { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { publishedModbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import type {
  MonitorCycle,
  MonitoredPlc,
  MonitoredTag,
  TagMonitorRuntime,
  TagRead,
} from "@/lib/runtimes/tag-monitor/monitor";
import {
  DEFAULT_SAMPLING_POLICY,
  sampleValue,
  type SamplingPolicy,
  shouldStore,
  type StoredSample,
} from "@/lib/runtimes/tag-monitor/sampler";
import { clearTagAlarms, pruneHistory, recordEvent, replayEvents, setTagAlarm } from "./event-service";

/**
 * Live state of a factory for the browser: tag values from the PLC tag monitor, device
 * states from the simulator, and the stream that carries their changes.
 *
 * Runtime memory is the authority here. The database is written to (telemetry samples,
 * alarms, events) and read only where no runtime is running, and then says so.
 */

export type LiveDeps = {
  db: PrismaClient;
  bus: EventBus;
  monitor: TagMonitorRuntime;
  simulator: DeviceSimulatorRuntime;
  pollMs?: number;
  sampling?: SamplingPolicy;
  retention?: { telemetryMs: number; eventsMs: number };
  /** Opens the Modbus reader of a PLC endpoint; tests replace it. */
  openReader?: (endpoint: { bindAddress: string; hostPort: number }) => TagRead;
  /** `false`: monitors get no timer; the caller runs cycles (tests). */
  autoTick?: boolean;
};

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

const PRUNE_EVERY_MS = 10 * 60_000;
/** How long after an event the device states are sent: long enough to cover the events that come with it. */
export const DEVICE_STATES_DELAY_MS = 120;
const housekeeping = globalThis as typeof globalThis & { zfactoryLastPruneAt?: number };
const syncing = globalThis as typeof globalThis & { zfactoryMonitorSync?: Map<string, Promise<void>> };

type PlcRecord = Awaited<ReturnType<typeof plcRepository.listFactoryPlcs>>[number];
type TagRecord = NonNullable<PlcRecord["plcProfile"]>["tags"][number];

const isMapped = (
  tag: TagRecord,
): tag is TagRecord & { protocolArea: NonNullable<TagRecord["protocolArea"]>; protocolAddress: number } =>
  tag.protocolArea !== null && tag.protocolAddress !== null;

function toMonitoredTag(
  tag: TagRecord & { protocolArea: NonNullable<TagRecord["protocolArea"]>; protocolAddress: number },
): MonitoredTag {
  return {
    id: tag.id,
    name: tag.name,
    role: tag.role,
    area: tag.protocolArea,
    address: tag.protocolAddress,
    wordCount: tag.wordCount,
    encoding: {
      dataType: tag.dataType,
      byteOrder: tag.byteOrder,
      wordOrder: tag.wordOrder,
      scale: tag.scale,
      offset: tag.offset,
    },
    deviceId: tag.sourceDeviceInstanceId,
  };
}

const modbusPort = (plc: PlcRecord) =>
  plc.runtimePorts.find((port) => port.protocol === "MODBUS_TCP" && port.hostPort !== null);

/** States in which a PLC's runtime is not expected to answer: it is down, or on its way up or down. */
const NOT_ANSWERING = new Set<RuntimeState>(["STOPPED", "STARTING", "STOPPING"]);

/** A PLC is monitored while Z-Factory has a started runtime for it. */
function shouldMonitor(plc: PlcRecord): boolean {
  return Boolean(plc.dockerContainerId) && Boolean(modbusPort(plc)) && !NOT_ANSWERING.has(plc.runtimeStatus);
}

async function maybePrune(deps: LiveDeps): Promise<void> {
  const now = Date.now();
  if (!deps.retention || now - (housekeeping.zfactoryLastPruneAt ?? 0) < PRUNE_EVERY_MS) return;
  housekeeping.zfactoryLastPruneAt = now;
  await pruneHistory(deps.db, deps.retention, now);
}

function startMonitor(deps: LiveDeps, plc: PlcRecord): void {
  const port = modbusPort(plc);
  const profile = plc.plcProfile;
  if (!port?.hostPort || !profile || deps.monitor.isRunning(plc.id)) return;
  const endpoint = { bindAddress: port.bindAddress, hostPort: port.hostPort };
  const read: TagRead =
    deps.openReader?.(endpoint) ??
    ((area, address, count) =>
      readModbus(publishedModbusEndpoint(endpoint.bindAddress, endpoint.hostPort), area, address, count));

  const tags = profile.tags.filter(isMapped).map(toMonitoredTag);
  const byName = new Map(tags.map((tag) => [tag.name, tag]));
  const policy = deps.sampling ?? DEFAULT_SAMPLING_POLICY;
  const stored = new Map<string, StoredSample>();

  /** An unchanged PLC is still confirmed to the browser this often, so its values do not go stale. */
  const CONFIRM_EVERY_MS = 1000;
  let publishedAtMs = 0;

  const onCycle = async (monitored: MonitoredPlc, cycle: MonitorCycle) => {
    const { at, reachable, changed, all } = cycle;
    const nowMs = at.getTime();
    if (changed.length > 0 || (reachable && nowMs - publishedAtMs >= CONFIRM_EVERY_MS)) {
      publishedAtMs = nowMs;
      deps.bus.publishLive(monitored.factoryId, {
        kind: "tags",
        factoryId: monitored.factoryId,
        plcId: monitored.plcId,
        at: at.toISOString(),
        confirmed: reachable,
        readings: changed,
      });
    }

    // Alarms the PLC program itself raises: a BOOL tag with the ALARM role.
    for (const reading of changed) {
      const tag = byName.get(reading.name);
      if (!tag || tag.role !== "ALARM" || reading.quality !== "GOOD" || typeof reading.value !== "boolean") continue;
      await setTagAlarm(
        deps,
        {
          factoryId: monitored.factoryId,
          deviceId: tag.deviceId ?? monitored.plcId,
          tagId: tag.id,
          code: `${TAG_ALARM_PREFIX}${tag.name}`,
          message: `${tag.name} is active`,
        },
        reading.value,
      );
    }

    // Telemetry: every reading is a candidate in every cycle; the policy decides.
    const samples = all.flatMap((reading) => {
      const tag = byName.get(reading.name);
      const value = sampleValue(reading.value);
      if (!tag || value === null) return [];
      const resolution = tag.encoding.dataType === "BOOL" ? 1 : (tag.encoding.scale ?? 1);
      if (!shouldStore(stored.get(tag.id), { value, quality: reading.quality }, nowMs, policy, resolution)) return [];
      stored.set(tag.id, { value, quality: reading.quality, atMs: nowMs });
      return [
        {
          factoryId: monitored.factoryId,
          deviceId: tag.deviceId ?? monitored.plcId,
          tagId: tag.id,
          valueNumber: value,
          quality: reading.quality,
          sampledAt: at,
        },
      ];
    });
    if (samples.length > 0) await eventRepository.insertSamples(deps.db, samples);
    await maybePrune(deps);
  };

  deps.monitor.start({
    plcId: plc.id,
    factoryId: plc.factoryId,
    mappingVersion: profile.modbusMappingVersion,
    tags,
    read,
    pollMs: deps.pollMs,
    autoTick: deps.autoTick,
    hooks: {
      onCycle,
      onLink: async (monitored, up) => {
        await recordEvent(deps, {
          type: up ? "CONNECTION_UP" : "CONNECTION_DOWN",
          factoryId: monitored.factoryId,
          deviceId: monitored.plcId,
          severity: up ? "INFO" : "WARNING",
          payload: { link: TAG_MONITOR_LINK },
        });
      },
    },
  });
}

async function stopMonitor(deps: LiveDeps, factoryId: string, plcId: string): Promise<void> {
  const tags = await deps.monitor.stop(plcId);
  // A PLC that is not running asserts nothing: its tag alarms and its link alarm end.
  await clearTagAlarms(
    deps,
    factoryId,
    tags.map((tag) => tag.id),
  );
  const link = await eventRepository.listActiveAlarms(deps.db, { factoryId, deviceId: plcId, code: PLC_LINK_ALARM });
  if (link.length > 0) {
    await recordEvent(deps, {
      type: "CONNECTION_UP",
      factoryId,
      deviceId: plcId,
      payload: { link: TAG_MONITOR_LINK, stopped: true },
    });
  }
  deps.bus.publishLive(factoryId, {
    kind: "tags",
    factoryId,
    plcId,
    at: new Date().toISOString(),
    confirmed: false,
    readings: tags.map((tag) => ({ plcId, name: tag.name, value: null, quality: "DISCONNECTED", readAt: null })),
  });
}

/**
 * Brings live monitoring in line with what is stored: a monitor for every PLC with a
 * started runtime (restarted when its tag mapping changed), none for the others. Also
 * corrects stored states no runtime stands behind any more: a simulated device cannot
 * be running when no simulation runs, e.g. after a server restart.
 */
export function syncFactoryMonitoring(deps: LiveDeps, factoryId: string): Promise<void> {
  // One at a time per factory: a pass that read the stored state before a PLC was stopped
  // must not start its monitor again after a later pass has stopped it.
  const queues = (syncing.zfactoryMonitorSync ??= new Map<string, Promise<void>>());
  const run = (queues.get(factoryId) ?? Promise.resolve()).then(
    () => syncMonitoring(deps, factoryId),
    () => syncMonitoring(deps, factoryId),
  );
  const settled = run.catch(() => undefined);
  queues.set(factoryId, settled);
  void settled.then(() => {
    if (queues.get(factoryId) === settled) queues.delete(factoryId);
  });
  return run;
}

/**
 * Stops reading one PLC before its runtime is taken down on purpose, so that going away
 * is not reported as a lost connection.
 */
export async function stopPlcMonitoring(deps: LiveDeps, actor: Actor, plcId: string): Promise<void> {
  const plc = await plcRepository.findForOwner(deps.db, actor.ownerId, plcId);
  if (!plc) throw notFound("PLC");
  if (deps.monitor.isRunning(plc.id)) await stopMonitor(deps, plc.factoryId, plc.id);
}

async function syncMonitoring(deps: LiveDeps, factoryId: string): Promise<void> {
  const plcs = await plcRepository.listFactoryPlcs(deps.db, factoryId);
  const wanted = new Map(plcs.filter(shouldMonitor).map((plc) => [plc.id, plc]));

  for (const monitored of deps.monitor.monitored().filter((candidate) => candidate.factoryId === factoryId)) {
    const plc = wanted.get(monitored.plcId);
    if (!plc || plc.plcProfile?.modbusMappingVersion !== monitored.mappingVersion) {
      await stopMonitor(deps, factoryId, monitored.plcId);
    }
  }
  for (const plc of wanted.values()) {
    if (!deps.monitor.isRunning(plc.id)) startMonitor(deps, plc);
  }

  if (!deps.simulator.isRunning(factoryId)) {
    const devices = await plcRepository.listFactoryDeviceStates(deps.db, factoryId);
    const orphaned = devices.filter(
      (device) => device.runtimeType === "DEVICE_SIM" && device.runtimeStatus !== "STOPPED",
    );
    if (orphaned.length > 0) {
      await simulationRepository.setRuntimeStatus(
        deps.db,
        orphaned.map((device) => device.id),
        "STOPPED",
      );
    }
  }
}

async function requireFactory(deps: LiveDeps, actor: Actor, factoryId: string) {
  const factory = await factoryRepository.findById(deps.db, actor.ownerId, factoryId);
  if (!factory) throw notFound("factory");
  return factory;
}

export type LiveTagRow = {
  plcId: string;
  plcName: string;
  name: string;
  role: TagRole;
  dataType: TagDataType;
  unit: string | null;
  logicalAddress: string | null;
  /** Only external command memory can be written; PLC logic, the field or a bridge produces the others. */
  writable: boolean;
  authority: TagAuthority;
  deviceName: string | null;
  reading: LiveTagReading;
};

export type LiveTagsView = {
  plcs: Array<{ id: string; name: string; runtimeStatus: RuntimeState; monitored: boolean; tagCount: number }>;
  tags: LiveTagRow[];
  staleAfterMs: number;
};

/** How long a value may go unconfirmed before it is shown as stale: several poll cycles. */
export const staleAfterMs = (pollMs: number | undefined) => Math.max(DEFAULT_STALE_AFTER_MS, (pollMs ?? 0) * 4);

/**
 * The Live Tags screen: every tag of the factory's PLCs with its current value from the
 * monitor's memory. A PLC that is not monitored has no value, not an old one.
 */
export async function getLiveTags(deps: LiveDeps, actor: Actor, factoryId: string): Promise<LiveTagsView> {
  await requireFactory(deps, actor, factoryId);
  await syncFactoryMonitoring(deps, factoryId);
  const plcs = await plcRepository.listFactoryPlcs(deps.db, factoryId);

  const tags = plcs.flatMap((plc) => {
    const live = new Map(deps.monitor.readings(plc.id).map((reading) => [reading.name, reading]));
    return (plc.plcProfile?.tags ?? [])
      .filter(isMapped)
      .sort((a, b) => a.name.localeCompare(b.name))
      .map((tag): LiveTagRow => ({
        plcId: plc.id,
        plcName: plc.name,
        name: tag.name,
        role: tag.role,
        dataType: tag.dataType,
        unit: tag.unit,
        logicalAddress: tag.logicalAddress,
        writable: isExternallyWritable(tag),
        authority: tagAuthority(tag),
        deviceName: tag.sourceDevice?.name ?? null,
        reading: live.get(tag.name) ?? {
          plcId: plc.id,
          name: tag.name,
          value: null,
          quality: "DISCONNECTED",
          readAt: null,
        },
      }));
  });

  return {
    plcs: plcs.map((plc) => ({
      id: plc.id,
      name: plc.name,
      runtimeStatus: plc.runtimeStatus,
      monitored: deps.monitor.isRunning(plc.id),
      tagCount: (plc.plcProfile?.tags ?? []).filter(isMapped).length,
    })),
    tags,
    staleAfterMs: staleAfterMs(deps.pollMs),
  };
}

/**
 * State of every device of the factory. A simulated device is read from simulator
 * memory while its simulation runs. When it does not, the device is stopped whatever the
 * database last stored, and the stored snapshot only dates what was last seen.
 */
export async function getDeviceStates(deps: LiveDeps, factoryId: string): Promise<LiveDeviceState[]> {
  const devices = await plcRepository.listFactoryDeviceStates(deps.db, factoryId);
  const live = new Map(deps.simulator.status(factoryId)?.devices.map((device) => [device.deviceId, device]));
  const now = new Date().toISOString();

  return devices.map((device) => {
    const simulated = live.get(device.id);
    if (simulated) {
      return {
        deviceId: device.id,
        name: device.name,
        status: simulated.faulted ? "FAULTED" : "RUNNING",
        source: "LIVE",
        quality: simulated.quality,
        at: now,
      };
    }
    if (device.runtimeType === "DEVICE_SIM") {
      return {
        deviceId: device.id,
        name: device.name,
        status: "STOPPED",
        source: device.runtimeSnapshot ? "SNAPSHOT" : "STORED",
        quality: "STALE",
        at: device.runtimeSnapshot?.capturedAt.toISOString() ?? null,
      };
    }
    // A PLC runtime's state is read from Docker by its Runtime screen; here it is the last one stored.
    return {
      deviceId: device.id,
      name: device.name,
      status: device.runtimeStatus,
      source: "STORED",
      quality: deps.monitor.status(device.id)?.up === false ? "DISCONNECTED" : "GOOD",
      at: null,
    };
  });
}

export async function getLiveSnapshot(deps: LiveDeps, factoryId: string): Promise<LiveSnapshot> {
  const [devices, activeAlarms] = await Promise.all([
    getDeviceStates(deps, factoryId),
    eventRepository.countActiveAlarms(deps.db, factoryId),
  ]);
  return {
    factoryId,
    at: new Date().toISOString(),
    tags: deps.monitor.readingsOfFactory(factoryId),
    devices,
    activeAlarms,
  };
}

/**
 * Opens the live stream of a factory. The client first gets what it missed (the events
 * after `lastEventId`, or a reset when that cannot be told), then the whole current
 * state, then everything as it happens. Returns the function that ends the stream.
 */
export async function openLiveStream(
  deps: LiveDeps,
  actor: Actor,
  factoryId: string,
  lastEventId: string | null,
  send: (message: LiveMessage) => void,
): Promise<() => void> {
  await requireFactory(deps, actor, factoryId);

  // Device states follow the events that may have changed them: one message for a burst.
  let closed = false;
  let pending: ReturnType<typeof setTimeout> | undefined;
  const sendDeviceStates = () => {
    pending = undefined;
    void getDeviceStates(deps, factoryId).then(
      (devices) => {
        if (!closed) send({ kind: "devices", factoryId, at: new Date().toISOString(), devices });
      },
      // The next event or reconnect brings the states; a failed read must not end the stream.
      () => undefined,
    );
  };
  const deliver = (message: LiveMessage) => {
    send(message);
    if (message.kind === "event" && !closed) pending ??= setTimeout(sendDeviceStates, DEVICE_STATES_DELAY_MS);
  };

  // Listen before reading history, so nothing recorded in between is lost.
  let buffer: LiveMessage[] | undefined = [];
  const stopListening = deps.bus.subscribeLive(factoryId, (message) => {
    if (buffer) buffer.push(message);
    else deliver(message);
  });
  const unsubscribe = () => {
    closed = true;
    clearTimeout(pending);
    stopListening();
  };

  try {
    await syncFactoryMonitoring(deps, factoryId);
    const replayed = new Set<string>();
    if (lastEventId) {
      const replay = await replayEvents(deps.db, factoryId, lastEventId);
      if (replay.kind === "RESET") send({ kind: "reset", reason: replay.reason });
      else {
        for (const event of replay.events) {
          replayed.add(event.id);
          send({ kind: "event", event });
        }
      }
    }
    send({ kind: "snapshot", snapshot: await getLiveSnapshot(deps, factoryId) });
    for (const message of buffer) {
      if (message.kind !== "event" || !replayed.has(message.event.id)) deliver(message);
    }
    buffer = undefined;
  } catch (error) {
    unsubscribe();
    throw error;
  }
  return unsubscribe;
}
