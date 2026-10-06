import "server-only";
import type { Actor } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { plcConfigRepository } from "@/lib/db/repositories/plc-config-repository";
import {
  type WireRecord,
  type WiringDeviceRecord,
  type WiringPointRecord,
  wiringRepository,
} from "@/lib/db/repositories/wiring-repository";
import type { IoPointType } from "@/lib/domain/device";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PairWiringView, WireEndView, WireView, WiringEndpointView } from "@/lib/domain/wiring-view";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { parseInput } from "@/lib/validation/parse";
import { type WireEnd, wireInputSchema } from "@/lib/validation/schemas";
import {
  checkWire,
  endpointName,
  endpointSummary,
  orientWire,
  pointFlow,
  type WireEndpoint,
  type WireEndpointKind,
  type WireEndpointType,
  type WireFlow,
  wireRelationship,
  type WireRule,
} from "@/lib/validation/wiring";
import { unwireInTransaction, wireTerminalInTransaction } from "./plc-config-service";

/**
 * Physical wiring (TASK-307, ADR-0014): one wire between two exact endpoints. An endpoint
 * is a terminal of a device, an I/O point of a PLC or a communication port. The stored
 * wires are the one source the tags, the simulator, the export and the views read; a wire
 * to a PLC channel creates the tag at that channel's address, and removing it removes the tag.
 *
 * Nothing is wired because two devices are connected: every wire names both its ends, and
 * a wire the rules refuse is never stored.
 */

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

const POINT_ORDER: readonly IoPointType[] = ["DI", "DO", "AI", "AO"];

const RULE_CODE: Record<WireRule, DomainErrorCode> = {
  "wire-same-device": "VALIDATION",
  "wire-kind": "INCOMPATIBLE",
  "wire-direction": "INCOMPATIBLE",
  "wire-signal-class": "INCOMPATIBLE",
  "wire-signal-type": "INCOMPATIBLE",
  "wire-protocol": "INCOMPATIBLE",
  "wire-duplicate": "CONFLICT",
  "wire-occupied": "OCCUPIED_ENDPOINT",
};

async function requireFactory(db: Db, actor: Actor, factoryId: string) {
  const factory = await factoryRepository.findById(db, actor.ownerId, factoryId);
  if (!factory) throw notFound("factory");
  return factory;
}

const channelOf = (point: WiringPointRecord) => {
  const channel = point.builtInChannel ?? point.moduleChannel;
  if (!channel) throw new DomainError("INVARIANT", "An I/O point has no catalog channel.", { ioPointId: point.id });
  return channel;
};

/** `DI a.0` on the CPU, `Slot 2 · AI 1` on a module. */
function pointLabel(point: WiringPointRecord): string {
  const channel = channelOf(point);
  const label = `${channel.ioType} ${channel.terminalLabel ?? channel.channelIndex}`;
  return point.factoryModule ? `Slot ${point.factoryModule.slotIndex} · ${label}` : label;
}

/** Built-in points first, then modules by slot; within each, DI, DO, AI, AO by channel number. */
function sortPoints(points: readonly WiringPointRecord[]): WiringPointRecord[] {
  const key = (point: WiringPointRecord) => {
    const channel = channelOf(point);
    return [point.factoryModule?.slotIndex ?? -1, POINT_ORDER.indexOf(channel.ioType), channel.channelIndex] as const;
  };
  return [...points].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

type Loaded = {
  devices: Map<string, WiringDeviceRecord>;
  points: Map<string, WiringPointRecord>;
  /** Endpoints of each loaded device, with the wires on them. */
  endpoints: Map<string, WireEndpoint[]>;
  /** Wires with an end on a loaded device. */
  wires: WireView[];
};

type EndRef = { deviceId: string; type: string; ref: string };

/** Labels of the ends of stored wires, on whatever device they are. */
async function labelEnds(db: Db, ends: readonly EndRef[]) {
  const ids = (type: WireEndpointType) => [...new Set(ends.filter((end) => end.type === type).map((end) => end.ref))];
  const [terminals, points, ports] = await Promise.all([
    wiringRepository.listTerminals(db, ids("DEVICE_IO")),
    wiringRepository.listPoints(db, ids("PLC_IO_POINT")),
    wiringRepository.listPorts(db, ids("PROTOCOL_PORT")),
  ]);
  const labels = new Map<string, string>();
  const kinds = new Map<string, WireEndpointKind>();
  for (const terminal of terminals) {
    labels.set(terminal.id, terminal.terminalLabel ?? "terminal");
    kinds.set(terminal.id, terminal.kind);
  }
  for (const point of points) labels.set(point.id, pointLabel(point));
  for (const port of ports) {
    labels.set(port.id, port.name);
    kinds.set(port.id, "BUS");
  }
  return { labels, kinds, points: new Map(points.map((point) => [point.id, point])) };
}

/** Stored wires as the views show them: both ends by name, and the tag of a PLC I/O wire. */
export async function describeWires(db: Db, records: readonly WireRecord[]): Promise<WireView[]> {
  const { labels, kinds, points } = await labelEnds(
    db,
    records.flatMap((wire) => [
      { deviceId: wire.sourceDeviceId, type: wire.sourceEndpointType, ref: wire.sourceEndpointRef },
      { deviceId: wire.targetDeviceId, type: wire.targetEndpointType, ref: wire.targetEndpointRef },
    ]),
  );
  const end = (device: { id: string; name: string }, type: string, ref: string): WireEndView => {
    const label = labels.get(ref) ?? "?";
    return {
      deviceId: device.id,
      deviceName: device.name,
      type: type as WireEndpointType,
      endpointId: ref,
      label,
      name: `${device.name} / ${label}`,
    };
  };
  return records.map((wire) => {
    const point = points.get(wire.sourceEndpointRef) ?? points.get(wire.targetEndpointRef);
    return {
      id: wire.id,
      kind: kinds.get(wire.sourceEndpointRef) ?? kinds.get(wire.targetEndpointRef) ?? "SIGNAL",
      from: end(wire.sourceDevice, wire.sourceEndpointType, wire.sourceEndpointRef),
      to: end(wire.targetDevice, wire.targetEndpointType, wire.targetEndpointRef),
      tagName: point?.tag?.name ?? null,
      logicalAddress: point?.logicalAddress ?? null,
    };
  });
}

const terminalFlow = (kind: string, direction: "INPUT" | "OUTPUT"): WireFlow =>
  kind === "SIGNAL" || kind === "POWER" ? (direction === "OUTPUT" ? "OUT" : "IN") : "NONE";

/** Loads devices of a factory with every endpoint they have and the wires on them. */
async function loadEndpoints(db: Db, factoryId: string, deviceIds: readonly string[]): Promise<Loaded> {
  const ids = [...new Set(deviceIds)];
  const devices = await wiringRepository.findDevices(db, factoryId, ids);
  if (devices.length !== ids.length) throw notFound("device");
  const plcIds = devices.filter((device) => device.deviceModel.architectureType !== null).map((device) => device.id);
  const [points, wires] = await Promise.all([
    wiringRepository.listPointsOf(db, plcIds),
    wiringRepository.listWires(db, ids).then((records) => describeWires(db, records)),
  ]);

  const wiresOn = (deviceId: string, endpointId: string): WireEndpoint["wires"] =>
    wires.flatMap((wire) => {
      const isFrom = wire.from.deviceId === deviceId && wire.from.endpointId === endpointId;
      const isTo = wire.to.deviceId === deviceId && wire.to.endpointId === endpointId;
      if (!isFrom && !isTo) return [];
      const other = isFrom ? wire.to : wire.from;
      return [
        { wireId: wire.id, otherDeviceId: other.deviceId, otherEndpointId: other.endpointId, otherName: other.name },
      ];
    });

  const endpoints = new Map<string, WireEndpoint[]>();
  for (const device of devices) {
    const base = { deviceId: device.id, deviceName: device.name };
    const own = sortPoints(points.filter((point) => point.plcInstanceId === device.id));
    endpoints.set(device.id, [
      ...own.map((point): WireEndpoint => {
        const channel = channelOf(point);
        return {
          ...base,
          type: "PLC_IO_POINT",
          id: point.id,
          label: pointLabel(point),
          kind: "SIGNAL",
          ...pointFlow(channel.ioType),
          signalType: channel.signalType,
          acceptedSignalTypes: channel.acceptedSignalTypes,
          protocols: [],
          maxConnections: 1,
          wires: wiresOn(device.id, point.id),
        };
      }),
      ...device.deviceModel.ioDefinitions.map((terminal): WireEndpoint => ({
        ...base,
        type: "DEVICE_IO",
        id: terminal.id,
        label: terminal.terminalLabel ?? "terminal",
        kind: terminal.kind,
        flow: terminalFlow(terminal.kind, terminal.direction),
        signalClass: terminal.kind === "SIGNAL" ? terminal.ioType : null,
        signalType: terminal.signalType || null,
        acceptedSignalTypes: [],
        protocols: [],
        maxConnections: terminal.maxConnections,
        wires: wiresOn(device.id, terminal.id),
      })),
      ...device.deviceModel.communicationPorts.map((port): WireEndpoint => ({
        ...base,
        type: "PROTOCOL_PORT",
        id: port.id,
        label: port.name,
        kind: "BUS",
        flow: "NONE",
        signalClass: null,
        signalType: null,
        acceptedSignalTypes: [],
        protocols: port.protocols,
        maxConnections: port.maxConnections,
        wires: wiresOn(device.id, port.id),
      })),
    ]);
  }
  return {
    devices: new Map(devices.map((device) => [device.id, device])),
    points: new Map(points.map((point) => [point.id, point])),
    endpoints,
    wires,
  };
}

const endpointKey = (endpoint: Pick<WireEndpoint, "type" | "id">) => `${endpoint.type}:${endpoint.id}`;

function findEndpoint(loaded: Loaded, end: WireEnd): WireEndpoint {
  const endpoint = loaded.endpoints
    .get(end.deviceId)
    ?.find((candidate) => candidate.type === end.type && candidate.id === end.id);
  if (!endpoint) {
    throw new DomainError("NOT_FOUND", "The endpoint does not exist on that device.", { field: "endpoint" });
  }
  return endpoint;
}

/** What makes a wire impossible beyond the rules of two endpoints. */
function refusalOf(a: WireEndpoint, b: WireEndpoint, ignoreWireId?: string) {
  const refused = checkWire(a, b, ignoreWireId);
  if (refused) return refused;
  if (a.type === "PLC_IO_POINT" && b.type === "PLC_IO_POINT") {
    // Two PLCs exchange data over a protocol mapping (Phase 07), not over each other's channels.
    return {
      rule: "wire-plc-to-plc" as const,
      message: `${endpointName(a)} and ${endpointName(b)} are both PLC channels; two PLCs are not wired channel to channel.`,
    };
  }
  return null;
}

/**
 * The two devices with all their endpoints, the wires between them, and for every pair
 * of endpoints why it cannot be wired, if it cannot. `replacingWireId` asks the question
 * for moving that wire: its own ends count as free.
 */
export async function getPairWiring(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  firstId: string,
  secondId: string,
  replacingWireId?: string,
): Promise<PairWiringView> {
  await requireFactory(db, actor, factoryId);
  if (firstId === secondId) throw new DomainError("VALIDATION", "Choose two different devices.");
  const loaded = await loadEndpoints(db, factoryId, [firstId, secondId]);
  const [first, second] = [loaded.endpoints.get(firstId) ?? [], loaded.endpoints.get(secondId) ?? []];

  const refusals: PairWiringView["refusals"] = {};
  for (const a of first) {
    for (const b of second) {
      const refused = refusalOf(a, b, replacingWireId);
      if (refused) (refusals[endpointKey(a)] ??= {})[endpointKey(b)] = refused.message;
    }
  }
  const toView = (endpoint: WireEndpoint): WiringEndpointView => ({
    key: endpointKey(endpoint),
    type: endpoint.type,
    id: endpoint.id,
    label: endpoint.label,
    kind: endpoint.kind,
    summary: endpointSummary(endpoint),
    maxConnections: endpoint.maxConnections,
    wires: endpoint.wires.map(({ wireId, otherName }) => ({ wireId, otherName })),
  });
  const between = (wire: WireView) =>
    (wire.from.deviceId === firstId && wire.to.deviceId === secondId) ||
    (wire.from.deviceId === secondId && wire.to.deviceId === firstId);
  return {
    first: { deviceId: firstId, name: loaded.devices.get(firstId)?.name ?? "", endpoints: first.map(toView) },
    second: { deviceId: secondId, name: loaded.devices.get(secondId)?.name ?? "", endpoints: second.map(toView) },
    wires: loaded.wires.filter(between),
    refusals,
    replacingWireId: replacingWireId ?? null,
  };
}

/** Removes one stored wire. A wire on a PLC channel takes its tag with it and frees the channel. */
async function removeInTransaction(transaction: Db, wire: WireRecord): Promise<void> {
  const onPlc =
    wire.sourceEndpointType === "PLC_IO_POINT"
      ? { plcId: wire.sourceDeviceId, pointId: wire.sourceEndpointRef }
      : wire.targetEndpointType === "PLC_IO_POINT"
        ? { plcId: wire.targetDeviceId, pointId: wire.targetEndpointRef }
        : undefined;
  if (onPlc) await unwireInTransaction(transaction, { id: onPlc.plcId }, [wire.id], [onPlc.pointId]);
  else await wiringRepository.deleteWire(transaction, wire.id);
}

/**
 * Validates and stores one wire inside the caller's transaction. With `replacing`, that
 * wire is removed first, but only once the new one is known to be allowed: a refused
 * replacement leaves the old wire as it was.
 */
async function connectInTransaction(
  transaction: Prisma.TransactionClient,
  factoryId: string,
  from: WireEnd,
  to: WireEnd,
  replacing?: WireRecord,
): Promise<{ wireId: string }> {
  await wiringRepository.lockDevices(transaction, [
    from.deviceId,
    to.deviceId,
    ...(replacing ? [replacing.sourceDeviceId, replacing.targetDeviceId] : []),
  ]);
  const loaded = await loadEndpoints(transaction, factoryId, [from.deviceId, to.deviceId]);
  const [a, b] = [findEndpoint(loaded, from), findEndpoint(loaded, to)];
  const refused = refusalOf(a, b, replacing?.id);
  if (refused) {
    const code = refused.rule === "wire-plc-to-plc" ? "INCOMPATIBLE" : RULE_CODE[refused.rule];
    throw new DomainError(code, refused.message, { rule: refused.rule, from: endpointName(a), to: endpointName(b) });
  }
  if (replacing) await removeInTransaction(transaction, replacing);

  const { source, target } = orientWire(a, b);
  const plcEnd = source.type === "PLC_IO_POINT" ? source : target.type === "PLC_IO_POINT" ? target : undefined;
  if (plcEnd) {
    const deviceEnd = plcEnd === source ? target : source;
    const device = loaded.devices.get(deviceEnd.deviceId);
    const terminal = device?.deviceModel.ioDefinitions.find((candidate) => candidate.id === deviceEnd.id);
    const point = loaded.points.get(plcEnd.id);
    if (!device || !terminal || !point) throw notFound("endpoint");
    const plc = { id: plcEnd.deviceId, factoryId };
    const connection = await wireTerminalInTransaction(transaction, plc, device.deviceModel, device, terminal, point);
    await plcConfigRepository.bumpIoMappingVersion(transaction, plc.id);
    return { wireId: connection.id };
  }

  const protocol =
    source.kind === "BUS" ? source.protocols.find((candidate) => target.protocols.includes(candidate)) : undefined;
  const { id } = await wiringRepository.createWire(transaction, {
    factoryId,
    sourceDeviceId: source.deviceId,
    targetDeviceId: target.deviceId,
    sourceEndpointType: source.type,
    sourceEndpointRef: source.id,
    targetEndpointType: target.type,
    targetEndpointRef: target.id,
    relationship: wireRelationship(source, target),
    protocol: protocol === "MODBUS_TCP" ? protocol : undefined,
  });
  return { wireId: id };
}

/** Wires two exact endpoints of two devices of the factory. Refused wiring is never stored. */
export async function connectWire(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  input: unknown,
): Promise<{ wireId: string }> {
  const data = parseInput(wireInputSchema, input);
  await requireFactory(db, actor, factoryId);
  return db.$transaction((transaction) => connectInTransaction(transaction, factoryId, data.from, data.to));
}

/**
 * Moves a wire to two other endpoints. The old wire stays until the new one is allowed;
 * then both changes happen together or not at all.
 */
export async function reconnectWire(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  wireId: string,
  input: unknown,
): Promise<{ wireId: string }> {
  const data = parseInput(wireInputSchema, input);
  await requireFactory(db, actor, factoryId);
  return db.$transaction(async (transaction) => {
    const wire = await wiringRepository.findWire(transaction, factoryId, wireId);
    if (!wire) throw notFound("wire");
    return connectInTransaction(transaction, factoryId, data.from, data.to, wire);
  });
}

/** Removes one wire. The devices stay; a PLC channel is free again and its tag is gone. */
export async function disconnectWire(db: PrismaClient, actor: Actor, factoryId: string, wireId: string): Promise<void> {
  await requireFactory(db, actor, factoryId);
  await db.$transaction(async (transaction) => {
    const wire = await wiringRepository.findWire(transaction, factoryId, wireId);
    if (!wire) throw notFound("wire");
    await wiringRepository.lockDevices(transaction, [wire.sourceDeviceId, wire.targetDeviceId]);
    await removeInTransaction(transaction, wire);
  });
}

/** Removes every wire between two devices, bus links excepted. Returns how many there were. */
export async function disconnectDevices(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  firstId: string,
  secondId: string,
): Promise<number> {
  await requireFactory(db, actor, factoryId);
  return db.$transaction(async (transaction) => {
    await wiringRepository.lockDevices(transaction, [firstId, secondId]);
    const wires = (await wiringRepository.listWires(transaction, [firstId])).filter(
      (wire) =>
        (wire.sourceDeviceId === secondId || wire.targetDeviceId === secondId) &&
        wire.sourceEndpointType !== "PROTOCOL_PORT",
    );
    for (const wire of wires) await removeInTransaction(transaction, wire);
    return wires.length;
  });
}
