import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { signalTypeLabel } from "@/lib/catalog/format";
import type { Db } from "@/lib/db/client";
import { deviceRepository } from "@/lib/db/repositories/device-repository";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { type ConfigPlcRecord, plcConfigRepository } from "@/lib/db/repositories/plc-config-repository";
import { plcRepository } from "@/lib/db/repositories/plc-repository";
import { tagRepository } from "@/lib/db/repositories/tag-repository";
import type { ChannelSummary } from "@/lib/domain/catalog-view";
import { type IoPointType, PLC_CATEGORY_CODE } from "@/lib/domain/device";
import { buildDeviceTree, type DeviceTreeNode } from "@/lib/domain/device-tree";
import { DomainError } from "@/lib/domain/errors";
import type {
  FactoryDeviceView,
  InstallableModuleView,
  PlcModelOption,
  PlcBankView,
  PlcConfigurationView,
  PlcPeripheralView,
  PlcPointView,
} from "@/lib/domain/plc-config-view";
import { findSignal, isSimulatedType } from "@/lib/domain/simulation";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { assignTerminals, type DeviceTerminal, type PlcChannel, sharedProtocols } from "@/lib/validation/compatibility";
import { requiredIoPointType } from "@/lib/validation/connection";
import {
  defaultAnalogScale,
  ioPointAddress,
  ioPointIndex,
  nextBlockIndex,
  tagNameFor,
} from "@/lib/validation/io-address";
import { parseInput } from "@/lib/validation/parse";
import { moduleInstallInputSchema, peripheralInputSchema, plcInputSchema } from "@/lib/validation/schemas";
import { connectDevicesInTransaction } from "./connection-service";
import { createTagInTransaction } from "./tag-service";

/**
 * PLC configuration (docs/design.md → PLC creation flow; ADR-0003): creating a PLC
 * instance from a catalog model, building a modular PLC from modules, and wiring
 * peripherals to its channels. Compact and modular PLCs take different paths to their
 * I/O points and the same path from there on.
 *
 * Everything here is configuration in PostgreSQL. Nothing starts a container.
 */

const POINT_ORDER: readonly IoPointType[] = ["DI", "DO", "AI", "AO"];
const BANK_LABELS: Record<IoPointType, string> = {
  DI: "Digital inputs",
  DO: "Digital outputs",
  AI: "Analog inputs",
  AO: "Analog outputs",
};

export type ConfigPlc = ConfigPlcRecord & { plcProfile: NonNullable<ConfigPlcRecord["plcProfile"]> };
export type PointRecord = ConfigPlc["plcProfile"]["ioPoints"][number];

const notFound = (what: string, field?: string) =>
  new DomainError("NOT_FOUND", `The ${what} does not exist.`, field ? { field } : {});

export async function loadConfigPlc(db: Db, actor: Actor, plcId: string): Promise<ConfigPlc> {
  const plc = await plcConfigRepository.findPlc(db, actor.ownerId, plcId);
  if (!plc) throw notFound("PLC");
  if (!plc.plcProfile || !plc.deviceModel.architectureType) {
    throw new DomainError("INCOMPATIBLE", "This device is not a PLC.", { rule: "plc-only" });
  }
  return plc as ConfigPlc;
}

export function channelOf(point: PointRecord) {
  const channel = point.builtInChannel ?? point.moduleChannel;
  if (!channel) throw new DomainError("INVARIANT", "An I/O point has no catalog channel.", { ioPointId: point.id });
  return channel;
}

/** Built-in points first, then modules by slot; within each, DI, DO, AI, AO by channel number. */
export function sortedPoints(plc: ConfigPlc): PointRecord[] {
  const slotOf = new Map(
    plc.plcProfile.racks.flatMap((rack) => rack.modules.map((module) => [module.id, module.slotIndex])),
  );
  const key = (point: PointRecord) => {
    const channel = channelOf(point);
    const slot = point.factoryModuleId ? (slotOf.get(point.factoryModuleId) ?? 0) : -1;
    return [slot, POINT_ORDER.indexOf(channel.ioType), channel.channelIndex] as const;
  };
  return [...plc.plcProfile.ioPoints].sort((a, b) => {
    const [ka, kb] = [key(a), key(b)];
    return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2];
  });
}

export const pointLabel = (point: PointRecord) => {
  const channel = channelOf(point);
  return channel.terminalLabel ?? String(channel.channelIndex);
};

const toChannel = (point: PointRecord): PlcChannel => {
  const channel = channelOf(point);
  return { ioType: channel.ioType, signalType: channel.signalType, acceptedSignalTypes: channel.acceptedSignalTypes };
};

/** Creates a PLC instance. A compact PLC gets its built-in I/O points; a modular one gets its empty rack. */
export async function createPlc(db: PrismaClient, actor: Actor, input: unknown): Promise<{ id: string }> {
  const data = parseInput(plcInputSchema, input);
  if (!(await factoryRepository.findById(db, actor.ownerId, data.factoryId))) throw notFound("factory", "factoryId");
  const model = await plcConfigRepository.findPlcModel(db, data.deviceModelId);
  if (!model || model.family.category.code !== PLC_CATEGORY_CODE || !model.architectureType) {
    throw new DomainError("INCOMPATIBLE", "Choose a PLC model from the catalog.", {
      rule: "plc-model",
      field: "deviceModelId",
    });
  }
  const rackProfile = model.family.rackProfiles[0];
  if (model.architectureType === "MODULAR" && !rackProfile) {
    throw new DomainError("INVARIANT", "The catalog has no rack for this CPU's family.", { rule: "rack-profile" });
  }

  return db.$transaction(async (transaction) => {
    const instance = await deviceRepository.createInstance(transaction, {
      factoryId: data.factoryId,
      deviceModelId: model.id,
      name: data.name,
      role: data.role || undefined,
      runtimeType: model.runtimeSupport,
      simulatorType: "NONE",
    });
    await deviceRepository.createPlcProfile(transaction, instance.id);
    if (model.architectureType === "COMPACT") {
      await plcConfigRepository.createIoPoints(
        transaction,
        model.builtInIoChannels.map((channel) => ({
          plcInstanceId: instance.id,
          sourceType: "BUILT_IN" as const,
          builtInChannelId: channel.id,
          logicalAddress: ioPointAddress(channel.ioType, channel.channelIndex),
        })),
      );
    } else if (rackProfile) {
      await plcConfigRepository.createRack(transaction, instance.id, rackProfile.id);
    }
    await plcRepository.recordEvent(transaction, {
      factoryId: data.factoryId,
      deviceId: instance.id,
      type: "DEVICE_CREATED",
      payloadJson: { model: model.modelName, architecture: model.architectureType },
    });
    return { id: instance.id };
  });
}

/** Removes a PLC and everything configured on it. Refused while its runtime container exists. */
export async function deletePlc(db: PrismaClient, actor: Actor, plcId: string): Promise<void> {
  const plc = await loadConfigPlc(db, actor, plcId);
  if (plc.dockerContainerId) {
    throw new DomainError("CONFLICT", "Remove the PLC's runtime before deleting the PLC.", { rule: "runtime-exists" });
  }
  await plcConfigRepository.deleteDevice(db, plc.id);
}

/** Installs a module in a free slot of a modular PLC and creates its I/O points. */
export async function installModule(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  input: unknown,
): Promise<{ id: string }> {
  const data = parseInput(moduleInstallInputSchema, input);
  const plc = await loadConfigPlc(db, actor, plcId);
  const rack = plc.plcProfile.racks[0];
  if (plc.deviceModel.architectureType !== "MODULAR" || !rack) {
    throw new DomainError("INCOMPATIBLE", "Only a modular PLC takes modules.", { rule: "modular-only" });
  }
  const compatibility = plc.deviceModel.moduleCompatibility.find((entry) => entry.moduleModelId === data.moduleModelId);
  if (!compatibility) {
    throw new DomainError("INCOMPATIBLE", "This module cannot be installed with this CPU.", {
      rule: "module-compatibility",
      field: "moduleModelId",
    });
  }
  const { slotCount } = rack.rackProfile;
  const minSlot = compatibility.minSlot ?? 1;
  const maxSlot = Math.min(compatibility.maxSlot ?? slotCount, slotCount);
  if (data.slotIndex < minSlot || data.slotIndex > maxSlot) {
    throw new DomainError("VALIDATION", `This module goes in slots ${minSlot} to ${maxSlot}.`, {
      rule: "slot-range",
      field: "slotIndex",
      minSlot,
      maxSlot,
    });
  }
  if (rack.modules.some((module) => module.slotIndex === data.slotIndex)) {
    throw new DomainError("OCCUPIED_ENDPOINT", `Slot ${data.slotIndex} already holds a module.`, {
      rule: "slot-occupied",
      field: "slotIndex",
    });
  }

  return db.$transaction(async (transaction) => {
    const installed = await plcConfigRepository.createModule(transaction, rack.id, data.moduleModelId, data.slotIndex);
    // New points go after everything in use, including tags the user placed by hand.
    const taken = [
      ...plc.plcProfile.ioPoints.map((point) => point.logicalAddress),
      ...(await plcConfigRepository.listFreeTagAddresses(transaction, plc.id)),
    ];
    const points = POINT_ORDER.flatMap((ioType) => {
      const channels = compatibility.moduleModel.channels.filter((channel) => channel.ioType === ioType);
      if (channels.length === 0) return [];
      const used = taken.flatMap((address) => ioPointIndex(ioType, address) ?? []);
      const start = nextBlockIndex(ioType, used, channels.length);
      return channels.map((channel, offset) => ({
        plcInstanceId: plc.id,
        sourceType: "MODULE" as const,
        factoryModuleId: installed.id,
        moduleChannelId: channel.id,
        logicalAddress: ioPointAddress(ioType, start + offset),
      }));
    });
    await plcConfigRepository.createIoPoints(transaction, points);
    await plcConfigRepository.bumpIoMappingVersion(transaction, plc.id);
    return { id: installed.id };
  });
}

/** Takes a module out of its slot. Refused while a device is wired to one of its channels. */
export async function removeModule(db: PrismaClient, actor: Actor, plcId: string, moduleId: string): Promise<void> {
  const plc = await loadConfigPlc(db, actor, plcId);
  const installed = plc.plcProfile.racks.flatMap((rack) => rack.modules).find((module) => module.id === moduleId);
  if (!installed) throw notFound("module");
  const inUse = plc.plcProfile.ioPoints.filter(
    (point) => point.factoryModuleId === moduleId && point.status !== "FREE",
  );
  if (inUse.length > 0) {
    throw new DomainError("CONFLICT", `Disconnect the ${inUse.length} wired channel(s) of this module first.`, {
      rule: "module-in-use",
    });
  }
  await db.$transaction(async (transaction) => {
    await plcConfigRepository.deleteModule(transaction, moduleId);
    await plcConfigRepository.bumpIoMappingVersion(transaction, plc.id);
  });
}

type ConnectionRecord = Awaited<ReturnType<typeof plcConfigRepository.listPlcConnections>>[number];

/** The PLC side and the device side of a connection, whichever way it points. */
function sides(connection: ConnectionRecord, plcId: string) {
  const plcIsSource = connection.sourceDeviceId === plcId;
  return {
    device: plcIsSource ? connection.targetDevice : connection.sourceDevice,
    plcEndpoint: plcIsSource
      ? { type: connection.sourceEndpointType, ref: connection.sourceEndpointRef }
      : { type: connection.targetEndpointType, ref: connection.targetEndpointRef },
    deviceEndpoint: plcIsSource
      ? { type: connection.targetEndpointType, ref: connection.targetEndpointRef }
      : { type: connection.sourceEndpointType, ref: connection.sourceEndpointRef },
  };
}

/** The PLC as configured: hardware, rack, every I/O point with what is wired to it, and its peripherals. */
export async function getPlcConfiguration(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
): Promise<PlcConfigurationView> {
  const plc = await loadConfigPlc(db, actor, plcId);
  const connections = await plcConfigRepository.listPlcConnections(db, plc.id);
  const terminalIds = connections.flatMap((connection) => {
    const { deviceEndpoint } = sides(connection, plc.id);
    return deviceEndpoint.type === "DEVICE_IO" ? [deviceEndpoint.ref] : [];
  });
  const terminals = new Map(
    (await plcConfigRepository.listTerminals(db, terminalIds)).map((terminal) => [terminal.id, terminal.terminalLabel]),
  );

  const wiredTo = new Map<string, { id: string; name: string; terminalLabel: string | null }>();
  const peripherals = new Map<string, PlcPeripheralView>();
  const points = sortedPoints(plc);
  const pointById = new Map(points.map((point) => [point.id, point]));

  for (const connection of connections) {
    const { device, plcEndpoint, deviceEndpoint } = sides(connection, plc.id);
    const direct = plcEndpoint.type === "PLC_IO_POINT";
    if (!direct && plcEndpoint.type !== "PROTOCOL_PORT") continue;
    const category = device.deviceModel.family.category;
    const peripheral = peripherals.get(device.id) ?? {
      deviceId: device.id,
      name: device.name,
      role: device.role,
      modelName: device.deviceModel.modelName,
      categoryName: category.name,
      connection: direct ? ("DIRECT_IO" as const) : ("PROTOCOL" as const),
      protocols: [],
      wires: [],
    };
    peripherals.set(device.id, peripheral);
    if (!direct) {
      if (connection.protocol && !peripheral.protocols.includes(connection.protocol))
        peripheral.protocols.push(connection.protocol);
      continue;
    }
    const point = pointById.get(plcEndpoint.ref);
    if (!point) continue;
    const terminalLabel = deviceEndpoint.type === "DEVICE_IO" ? (terminals.get(deviceEndpoint.ref) ?? null) : null;
    wiredTo.set(point.id, { id: device.id, name: device.name, terminalLabel });
    peripheral.wires.push({
      terminalLabel,
      ioType: channelOf(point).ioType,
      pointLabel: pointLabel(point),
      logicalAddress: point.logicalAddress,
      tagName: point.tag?.name ?? null,
    });
  }

  const slotOf = new Map(plc.plcProfile.racks.flatMap((rack) => rack.modules.map((module) => [module.id, module])));
  const banks = new Map<string, PlcBankView>();
  for (const point of points) {
    const channel = channelOf(point);
    const installed = point.factoryModuleId ? slotOf.get(point.factoryModuleId) : undefined;
    const key = `${installed ? `slot${installed.slotIndex}` : "builtin"}-${channel.ioType}`;
    const bank = banks.get(key) ?? {
      key,
      label: installed
        ? `Slot ${installed.slotIndex} · ${installed.moduleModel.modelName}`
        : BANK_LABELS[channel.ioType],
      ioType: channel.ioType,
      slotIndex: installed?.slotIndex ?? null,
      points: [],
    };
    banks.set(key, bank);
    const view: PlcPointView = {
      id: point.id,
      ioType: channel.ioType,
      label: pointLabel(point),
      vendorAddress: point.builtInChannel?.addressHint ?? null,
      logicalAddress: point.logicalAddress,
      signalTypes: [channel.signalType, ...channel.acceptedSignalTypes],
      status: point.status,
      device: wiredTo.get(point.id) ?? null,
      tagName: point.tag?.name ?? null,
    };
    bank.points.push(view);
  }

  const rack = plc.plcProfile.racks[0];
  const model = plc.deviceModel;
  const electrical = model.electricalProfile;
  return {
    plc: {
      id: plc.id,
      factoryId: plc.factoryId,
      name: plc.name,
      role: plc.role,
      runtimeStatus: plc.runtimeStatus,
      architectureType: model.architectureType as "COMPACT" | "MODULAR",
      ioMappingVersion: plc.plcProfile.ioMappingVersion,
      modbusMappingVersion: plc.plcProfile.modbusMappingVersion,
    },
    model: {
      id: model.id,
      manufacturer: model.family.manufacturer.name,
      family: model.family.name,
      modelName: model.modelName,
      sku: model.sku,
      verificationStatus: model.verificationStatus,
    },
    electrical: electrical
      ? {
          supplyType: electrical.supplyType,
          nominalVoltage: electrical.nominalVoltage,
          voltageMin: electrical.voltageMin,
          voltageMax: electrical.voltageMax,
        }
      : null,
    ports: model.communicationPorts.map((port) => ({
      name: port.name,
      physicalType: port.physicalType,
      protocols: port.protocols,
      portCount: port.portCount,
    })),
    rack: rack
      ? {
          name: rack.rackProfile.name,
          slotCount: rack.rackProfile.slotCount,
          slots: Array.from({ length: rack.rackProfile.slotCount }, (_, index) => {
            const installed = rack.modules.find((module) => module.slotIndex === index + 1);
            const modulePoints = installed ? points.filter((point) => point.factoryModuleId === installed.id) : [];
            return {
              slotIndex: index + 1,
              module: installed
                ? {
                    id: installed.id,
                    modelName: installed.moduleModel.modelName,
                    sku: installed.moduleModel.sku,
                    moduleType: installed.moduleModel.moduleType,
                    pointCount: modulePoints.length,
                    occupiedCount: modulePoints.filter((point) => point.status !== "FREE").length,
                  }
                : null,
            };
          }),
        }
      : null,
    banks: [...banks.values()],
    occupancy: { total: points.length, occupied: points.filter((point) => point.status !== "FREE").length },
    peripherals: [...peripherals.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

function summarizeChannels(channels: ReadonlyArray<PlcChannel & { acceptedSignalTypes: string[] }>): ChannelSummary[] {
  const groups = new Map<string, ChannelSummary>();
  for (const channel of channels) {
    const key = `${channel.ioType}|${channel.signalType}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else
      groups.set(key, {
        ioType: channel.ioType,
        count: 1,
        signalType: channel.signalType,
        acceptedSignalTypes: channel.acceptedSignalTypes,
      });
  }
  return [...groups.values()];
}

/** Modules the catalog allows with this CPU. Nothing else can be installed. */
export async function listInstallableModules(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
): Promise<InstallableModuleView[]> {
  const plc = await loadConfigPlc(db, actor, plcId);
  return plc.deviceModel.moduleCompatibility
    .map((entry) => ({
      id: entry.moduleModel.id,
      modelName: entry.moduleModel.modelName,
      sku: entry.moduleModel.sku,
      moduleType: entry.moduleModel.moduleType,
      channels: summarizeChannels(entry.moduleModel.channels),
    }))
    .sort((a, b) => a.modelName.localeCompare(b.modelName));
}

const toTerminal = (terminal: {
  terminalLabel: string | null;
  direction: "INPUT" | "OUTPUT";
  ioType: "DIGITAL" | "ANALOG";
  signalType: string;
}): DeviceTerminal => ({
  terminalLabel: terminal.terminalLabel,
  direction: terminal.direction,
  ioType: terminal.ioType,
  signalType: terminal.signalType,
});

async function uniqueTagName(transaction: Db, plcId: string, base: string): Promise<string> {
  for (let suffix = 1; suffix < 100; suffix += 1) {
    const name = suffix === 1 ? base : `${base}_${suffix}`;
    if (!(await tagRepository.findByName(transaction, plcId, name))) return name;
  }
  throw new DomainError("CONFLICT", "No free tag name could be derived for this device.", { rule: "tag-name" });
}

export type PeripheralModel = NonNullable<Awaited<ReturnType<typeof plcConfigRepository.findPeripheralModel>>>;
type WiringPlan = ReturnType<typeof planWiring>;

/** Checks that the model can connect to the PLC at all and picks a channel for every terminal not assigned by hand. */
function planWiring(plc: ConfigPlc, model: PeripheralModel, assignments: Readonly<Record<string, string>>) {
  const protocols = sharedProtocols(plc.deviceModel.communicationPorts, model.communicationPorts);
  if (model.ioDefinitions.length === 0 && protocols.length === 0) {
    throw new DomainError(
      "INCOMPATIBLE",
      `${model.modelName} has no terminal or shared protocol to connect to this PLC.`,
      {
        rule: "no-plc-connection",
        field: "deviceModelId",
      },
    );
  }
  const points = sortedPoints(plc);
  const pointIndex = new Map(points.map((point, index) => [point.id, index]));
  const terminalIds = new Set(model.ioDefinitions.map((terminal) => terminal.id));
  for (const [terminalId, pointId] of Object.entries(assignments)) {
    if (!terminalIds.has(terminalId)) throw notFound("terminal", "assignments");
    if (!pointIndex.has(pointId)) throw notFound("I/O point", "assignments");
  }
  // Channels chosen by hand are kept out of the automatic assignment of the other terminals.
  const reserved = new Set(Object.values(assignments).flatMap((pointId) => pointIndex.get(pointId) ?? []));
  const occupied = new Set(points.flatMap((point, index) => (point.status === "FREE" ? [] : [index])));
  const automatic = assignTerminals(
    model.ioDefinitions.map(toTerminal),
    points.map(toChannel),
    new Set([...reserved, ...occupied]),
  );
  return { points, pointIndex, automatic, protocols, assignments };
}

/**
 * One wire between a signal terminal of a device and a channel of the PLC, inside the
 * caller's transaction: the connection, and the tag at the channel's address that the
 * program, the simulator and the Modbus map read. The caller bumps the mapping version.
 */
export async function wireTerminalInTransaction(
  transaction: Db,
  plc: { id: string; factoryId: string },
  model: { runtimeSupport: string; family: { category: { simulatorType: string } } },
  device: { id: string; name: string },
  terminal: Pick<
    PeripheralModel["ioDefinitions"][number],
    "id" | "direction" | "ioType" | "terminalLabel" | "unit" | "simulatorSignal"
  >,
  point: { id: string; logicalAddress: string },
) {
  const category = model.family.category;
  const simulated = model.runtimeSupport === "DEVICE_SIM" && isSimulatedType(category.simulatorType);
  const deviceSide = { deviceId: device.id, endpointType: "DEVICE_IO" as const, endpointRef: terminal.id };
  const plcSide = { deviceId: plc.id, endpointType: "PLC_IO_POINT" as const, endpointRef: point.id };
  // Checks point class, signal type and that the point is still free; marks it occupied.
  const connection = await connectDevicesInTransaction(
    transaction,
    terminal.direction === "OUTPUT"
      ? { factoryId: plc.factoryId, relationship: "FEEDS_BACK_TO", source: deviceSide, target: plcSide }
      : { factoryId: plc.factoryId, relationship: "CONTROLS", source: plcSide, target: deviceSide },
  );

  const signal =
    simulated && terminal.simulatorSignal && isSimulatedType(category.simulatorType)
      ? findSignal(category.simulatorType, terminal.simulatorSignal)
      : undefined;
  const analog = terminal.ioType === "ANALOG";
  const measured = terminal.direction === "OUTPUT" && analog && category.simulatorType === "SENSOR";
  await createTagInTransaction(
    transaction,
    plc,
    {
      name: await uniqueTagName(transaction, plc.id, tagNameFor(device.name, terminal.terminalLabel)),
      dataType: analog ? "INT16" : "BOOL",
      // Read-only for gateways either way: the program drives outputs, the device drives inputs.
      role: measured ? "PROCESS_VALUE" : terminal.direction === "OUTPUT" && analog ? "FEEDBACK" : "STATUS",
      logicalAddress: point.logicalAddress,
      scale: analog ? defaultAnalogScale(signal?.unit ?? terminal.unit ?? undefined) : 1,
      offset: 0,
      unit: signal?.unit ?? terminal.unit ?? undefined,
      sourceDeviceInstanceId: device.id,
      sourceSignal: signal?.key,
    },
    { plcIoPointId: point.id },
  );
  return connection;
}

/**
 * Connects a device to the PLC inside the caller's transaction: every terminal is wired to
 * its channel and gets a tag at that channel's address; a device without terminals is
 * linked over the shared protocol.
 */
async function wireInTransaction(
  transaction: Db,
  plc: ConfigPlc,
  model: PeripheralModel,
  device: { id: string; name: string },
  plan: WiringPlan,
): Promise<void> {
  for (const [index, terminal] of model.ioDefinitions.entries()) {
    const chosen = plan.assignments[terminal.id];
    const point = chosen ? plan.points[plan.pointIndex.get(chosen) ?? -1] : plan.points[plan.automatic[index] ?? -1];
    const required = requiredIoPointType(terminal.direction, terminal.ioType);
    if (!point) {
      throw new DomainError(
        "INCOMPATIBLE",
        `No free ${required} channel accepts ${terminal.terminalLabel ?? "this terminal"} (${signalTypeLabel(terminal.signalType)}).`,
        { rule: "no-free-channel", terminal: terminal.terminalLabel, required },
      );
    }
    await wireTerminalInTransaction(transaction, plc, model, device, terminal, point);
  }

  if (model.ioDefinitions.length === 0) {
    const protocol = plan.protocols[0];
    const plcPort = plc.deviceModel.communicationPorts.find((port) =>
      port.protocols.some((candidate) => candidate === protocol),
    );
    const devicePort = model.communicationPorts.find((port) =>
      port.protocols.some((candidate) => candidate === protocol),
    );
    if (!plcPort || !devicePort || protocol !== "MODBUS_TCP") {
      throw new DomainError("INVARIANT", "The shared protocol has no port on one side.", { rule: "protocol-port" });
    }
    await transaction.deviceConnection.create({
      data: {
        factoryId: plc.factoryId,
        sourceDeviceId: plc.id,
        targetDeviceId: device.id,
        sourceEndpointType: "PROTOCOL_PORT",
        sourceEndpointRef: plcPort.id,
        targetEndpointType: "PROTOCOL_PORT",
        targetEndpointRef: devicePort.id,
        relationship: "COMMUNICATES_WITH",
        protocol,
      },
    });
  }
  await plcConfigRepository.bumpIoMappingVersion(transaction, plc.id);
}

/**
 * Creates a device instance from a catalog model and connects it to the PLC in one step:
 * each terminal is wired to a free compatible channel and gets a tag at that channel's
 * address; a protocol device is linked over a shared protocol instead. All or nothing.
 */
export async function addPeripheral(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  input: unknown,
): Promise<{ deviceId: string }> {
  const data = parseInput(peripheralInputSchema, input);
  const plc = await loadConfigPlc(db, actor, plcId);
  const model = await plcConfigRepository.findPeripheralModel(db, data.deviceModelId);
  if (!model || model.family.category.code === PLC_CATEGORY_CODE) throw notFound("catalog model", "deviceModelId");
  const plan = planWiring(plc, model, data.assignments);

  return db.$transaction(async (transaction) => {
    const device = await deviceRepository.createInstance(transaction, {
      factoryId: plc.factoryId,
      deviceModelId: model.id,
      name: data.name,
      role: data.role || undefined,
      runtimeType: model.runtimeSupport,
      simulatorType: model.family.category.simulatorType,
    });
    await wireInTransaction(transaction, plc, model, device, plan);
    await plcRepository.recordEvent(transaction, {
      factoryId: plc.factoryId,
      deviceId: device.id,
      type: "DEVICE_CREATED",
      payloadJson: { model: model.modelName, connectedTo: plc.name },
    });
    return { deviceId: device.id };
  });
}

/** The connections between this PLC and one device, with the I/O points they use. */
async function connectionsTo(db: Db, plc: ConfigPlc, deviceId: string) {
  const connections = (await plcConfigRepository.listPlcConnections(db, plc.id)).filter(
    (connection) => sides(connection, plc.id).device.id === deviceId,
  );
  const pointIds = connections.flatMap((connection) => {
    const { plcEndpoint } = sides(connection, plc.id);
    return plcEndpoint.type === "PLC_IO_POINT" ? [plcEndpoint.ref] : [];
  });
  return { connections, pointIds };
}

/** Removes wires of a PLC inside the caller's transaction: their tags go, their channels are free again. */
export async function unwireInTransaction(
  transaction: Db,
  plc: { id: string },
  connectionIds: string[],
  pointIds: string[],
) {
  await plcConfigRepository.deleteTagsOfPoints(transaction, pointIds);
  await plcConfigRepository.deleteConnections(transaction, connectionIds);
  await plcConfigRepository.freeIoPoints(transaction, pointIds);
  await plcConfigRepository.bumpIoMappingVersion(transaction, plc.id);
  if (pointIds.length > 0) await plcRepository.bumpModbusMappingVersion(transaction, plc.id);
}

/** Disconnects a device from the PLC: frees its channels and removes their tags. The device stays. */
export async function unwireDevice(db: PrismaClient, actor: Actor, plcId: string, deviceId: string): Promise<void> {
  const plc = await loadConfigPlc(db, actor, plcId);
  const { connections, pointIds } = await connectionsTo(db, plc, deviceId);
  if (connections.length === 0) throw notFound("connection");
  await db.$transaction((transaction) =>
    unwireInTransaction(
      transaction,
      plc,
      connections.map((connection) => connection.id),
      pointIds,
    ),
  );
}

/** Every device of a factory, PLCs included, for the factory overview. */
export async function listFactoryDevices(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
): Promise<FactoryDeviceView[]> {
  if (!(await factoryRepository.findById(db, actor.ownerId, factoryId))) throw notFound("factory");
  return (await plcConfigRepository.listFactoryDevices(db, factoryId)).map((device) => ({
    id: device.id,
    name: device.name,
    role: device.role,
    modelName: device.deviceModel.modelName,
    manufacturer: device.deviceModel.family.manufacturer.name,
    categoryCode: device.deviceModel.family.category.code,
    categoryName: device.deviceModel.family.category.name,
    architectureType: device.deviceModel.architectureType,
    runtimeStatus: device.runtimeStatus,
  }));
}

/**
 * The devices of a factory as they are connected: each PLC with the devices connected to
 * it, and below a device what is reached through it. Every device appears once.
 */
export async function getFactoryDeviceTree(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
): Promise<DeviceTreeNode<FactoryDeviceView>[]> {
  const [devices, links] = await Promise.all([
    listFactoryDevices(db, actor, factoryId),
    plcConfigRepository.listFactoryLinks(db, factoryId),
  ]);
  return buildDeviceTree(devices, links, (device) => device.architectureType !== null);
}

/** PLC catalog models of one architecture, for the create form. */
export async function listPlcModels(
  db: PrismaClient,
  architectureType: "COMPACT" | "MODULAR",
): Promise<PlcModelOption[]> {
  return (await plcConfigRepository.listPlcModels(db, architectureType)).map((model) => {
    const counts = POINT_ORDER.map(
      (ioType) => [ioType, model.builtInIoChannels.filter((channel) => channel.ioType === ioType).length] as const,
    );
    return {
      id: model.id,
      manufacturer: model.family.manufacturer.name,
      family: model.family.name,
      modelName: model.modelName,
      sku: model.sku,
      verificationStatus: model.verificationStatus,
      io:
        architectureType === "COMPACT"
          ? counts
              .filter(([, count]) => count > 0)
              .map(([ioType, count]) => `${count} ${ioType}`)
              .join(" · ")
          : `${model.moduleCompatibility.length} installable modules`,
      ports: model.communicationPorts.map((port) => `${port.name} ×${port.portCount}`).join(", "),
    };
  });
}
