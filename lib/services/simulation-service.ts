import "server-only";
import { randomUUID } from "node:crypto";
import type { Actor } from "@/lib/auth/actor";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import {
  type SignalTagRecord,
  type SimulatedDeviceRecord,
  simulationRepository,
} from "@/lib/db/repositories/simulation-repository";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import { findSignal, isLoadType, isSimulatedType, type SimulatedType } from "@/lib/domain/simulation";
import type { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type ModbusEndpoint, readModbus, writeModbus, writeModbusRegisters } from "@/lib/protocols/modbus/client";
import type { PlcIo, SignalBinding } from "@/lib/runtimes/device-sim/bridge";
import type { DeviceConfig, DeviceSnapshot, SimEvent } from "@/lib/runtimes/device-sim/engine";
import type { DeviceSimulatorRuntime, SimulationStatus } from "@/lib/runtimes/device-sim/runtime";
import { publishedModbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import { parseInput } from "@/lib/validation/parse";
import { faultCodeSchema, forcedValueSchema } from "@/lib/validation/schemas";

/**
 * The device simulation of a factory: builds it from the persisted devices, connections,
 * simulation profiles and signal tags, runs it in the shared simulator, and persists its
 * meaningful events and periodic snapshots.
 *
 * The simulator is field equipment, not a controller: it reads what PLC logic drives and
 * returns feedback. Fault injection, reset and forced values are explicit operator
 * actions on the simulated equipment and are always recorded.
 */

export type SimulationDeps = {
  db: PrismaClient;
  simulator: DeviceSimulatorRuntime;
  tickMs?: number;
  snapshotIntervalMs?: number;
  /** Live listeners (SSE) receive every event that is persisted. */
  bus?: EventBus;
};

export type SimulationPlan = {
  devices: DeviceConfig[];
  bindings: SignalBinding[];
  plcs: Map<string, { name: string; endpoint: ModbusEndpoint | null }>;
  /** Devices of the factory the simulator leaves alone, and why. */
  skipped: Array<{ deviceId: string; name: string; reason: string }>;
};

export type SimulationState = { running: false } | ({ running: true } & SimulationStatus);

const GENERATOR_KINDS = ["CONSTANT", "RAMP", "SINE", "RANDOM"];

function notFound(what: string): DomainError {
  return new DomainError("NOT_FOUND", `The ${what} does not exist.`);
}

/** Behaviour parameters: the instance's simulation profile, else the catalog model's, else defaults. */
function profileParams(device: SimulatedDeviceRecord, type: SimulatedType): unknown {
  const profile = device.simulationProfiles[0] ?? device.deviceModel.simulationProfiles[0];
  if (!profile) return undefined;
  const parameters = profile.parametersJson;
  if (profile.kind === "STATE_MACHINE") return parameters;
  // A signal-generator profile describes the source of a sensor (or the state of a switch).
  const generator = GENERATOR_KINDS.includes(profile.kind) && (type === "SENSOR" || type === "SWITCH");
  if (!generator || (type === "SWITCH" && profile.kind !== "CONSTANT")) {
    throw new DomainError("VALIDATION", `${device.name} has a ${profile.kind} simulation profile it cannot use.`, {
      rule: "simulation-profile",
      device: device.name,
      kind: profile.kind,
    });
  }
  const source = typeof parameters === "object" && parameters !== null && !Array.isArray(parameters) ? parameters : {};
  return { source: { ...source, kind: profile.kind } };
}

function toDeviceConfig(
  device: SimulatedDeviceRecord,
  type: SimulatedType,
  simulated: ReadonlySet<string>,
): DeviceConfig {
  const incoming = (relationship: string) =>
    device.incomingConnections.find(
      (connection) => connection.relationship === relationship && simulated.has(connection.sourceDeviceId),
    )?.sourceDeviceId;
  return {
    id: device.id,
    name: device.name,
    type,
    params: profileParams(device, type),
    faults: Object.fromEntries(
      device.deviceModel.faultDefinitions.map((fault) => [
        fault.code,
        { severity: fault.severity, latching: fault.resetBehavior === "MANUAL" },
      ]),
    ),
    driveId: type === "MOTOR" ? incoming("DRIVES") : undefined,
    motorId: isLoadType(type) ? incoming("MECHANICALLY_DRIVES") : undefined,
    measuresId:
      type === "SENSOR" || type === "SWITCH"
        ? device.outgoingConnections.find((connection) => simulated.has(connection.targetDeviceId))?.targetDeviceId
        : undefined,
  };
}

function toBinding(tag: SignalTagRecord, type: SimulatedType): SignalBinding | undefined {
  const signal = tag.sourceSignal ? findSignal(type, tag.sourceSignal) : undefined;
  if (!signal || !tag.sourceDeviceInstanceId || tag.protocolArea === null || tag.protocolAddress === null) {
    return undefined;
  }
  return {
    deviceId: tag.sourceDeviceInstanceId,
    signal: signal.key,
    direction: signal.direction,
    kind: signal.kind,
    plcId: tag.plcInstanceId,
    tagName: tag.name,
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
  };
}

/** What the simulator would run for this factory, from persisted configuration only. */
export async function planSimulation(db: PrismaClient, actor: Actor, factoryId: string): Promise<SimulationPlan> {
  if (!(await factoryRepository.findById(db, actor.ownerId, factoryId))) throw notFound("factory");

  const records = await simulationRepository.listDevices(db, factoryId);
  const types = new Map<string, SimulatedType>();
  const skipped: SimulationPlan["skipped"] = [];
  for (const record of records) {
    if (isSimulatedType(record.simulatorType)) types.set(record.id, record.simulatorType);
    else {
      skipped.push({
        deviceId: record.id,
        name: record.name,
        reason: `Simulator type ${record.simulatorType} has no behaviour model.`,
      });
    }
  }
  const simulated = new Set(types.keys());
  const devices = records.flatMap((record) => {
    const type = types.get(record.id);
    return type ? [toDeviceConfig(record, type, simulated)] : [];
  });

  const bindings: SignalBinding[] = [];
  const plcs: SimulationPlan["plcs"] = new Map();
  for (const tag of await simulationRepository.listSignalTags(db, factoryId)) {
    const type = tag.sourceDeviceInstanceId ? types.get(tag.sourceDeviceInstanceId) : undefined;
    const binding = type ? toBinding(tag, type) : undefined;
    if (!binding) continue;
    bindings.push(binding);
    const plc = tag.plc.deviceInstance;
    const port = plc.runtimePorts.find((candidate) => candidate.protocol === "MODBUS_TCP" && candidate.hostPort);
    plcs.set(plc.id, {
      name: plc.name,
      endpoint: port?.hostPort ? publishedModbusEndpoint(port.bindAddress, port.hostPort) : null,
    });
  }
  return { devices, bindings, plcs, skipped };
}

function modbusIo(endpoint: ModbusEndpoint): PlcIo {
  return {
    read: (area, address, count) => readModbus(endpoint, area, address, count),
    writeCoil: (address, value) => writeModbus(endpoint, "COIL", address, value),
    writeRegisters: (address, words) => writeModbusRegisters(endpoint, address, words),
  };
}

const QUALITY = { GOOD: "GOOD", BAD: "BAD" } as const;

function toSnapshotRow(device: DeviceSnapshot) {
  return {
    deviceInstanceId: device.deviceId,
    status: device.faulted ? ("FAULTED" as const) : ("RUNNING" as const),
    quality: QUALITY[device.quality],
    valuesJson: {
      state: device.state,
      tripped: device.tripped,
      activeFaults: device.activeFaults,
      inputs: device.inputs,
      outputs: device.outputs,
    },
  };
}

/** Persists and broadcasts events; a trip or its release also updates the device's stored status. */
async function recordEvents(deps: SimulationDeps, events: RuntimeEventEnvelope[]): Promise<void> {
  await simulationRepository.recordEvents(deps.db, events);
  for (const event of events) {
    if (!event.deviceId || !event.type.endsWith("_STATE_CHANGED")) continue;
    if (event.payload.to === "FAULTED") {
      await simulationRepository.setRuntimeStatus(deps.db, [event.deviceId], "FAULTED");
    } else if (event.payload.from === "FAULTED") {
      await simulationRepository.setRuntimeStatus(deps.db, [event.deviceId], "RUNNING");
    }
  }
  events.forEach((event) => deps.bus?.publish(event));
}

async function recordFactoryEvent(
  deps: SimulationDeps,
  factoryId: string,
  type: string,
  payload: Record<string, unknown>,
) {
  await recordEvents(deps, [
    {
      version: 1,
      id: randomUUID(),
      type,
      factoryId,
      deviceId: null,
      severity: "INFO",
      occurredAt: new Date().toISOString(),
      payload,
    },
  ]);
}

/**
 * Starts the device simulation of a factory. Every PLC a device is wired to must have
 * its Modbus endpoint configured (it is, once the PLC has been started); a PLC that is
 * not running simply drives nothing until it comes up.
 */
export async function startFactorySimulation(
  deps: SimulationDeps,
  actor: Actor,
  factoryId: string,
  options: { autoTick?: boolean } = {},
): Promise<SimulationState & { skipped: SimulationPlan["skipped"] }> {
  const plan = await planSimulation(deps.db, actor, factoryId);
  if (deps.simulator.isRunning(factoryId)) {
    throw new DomainError("CONFLICT", "The device simulation of this factory is already running.", {
      rule: "simulation-running",
    });
  }
  if (plan.devices.length === 0) {
    throw new DomainError("CONFLICT", "This factory has no devices the simulator can run.", {
      rule: "nothing-to-simulate",
    });
  }
  const plcs = new Map<string, PlcIo>();
  for (const [plcId, plc] of plan.plcs) {
    if (!plc.endpoint) {
      throw new DomainError("CONFLICT", `Start ${plc.name} first: its Modbus endpoint is not configured yet.`, {
        rule: "plc-endpoint-required",
        plcId,
      });
    }
    plcs.set(plcId, modbusIo(plc.endpoint));
  }

  deps.simulator.start(factoryId, {
    config: { factoryId, devices: plan.devices },
    bindings: plan.bindings,
    plcs,
    tickMs: deps.tickMs,
    snapshotIntervalMs: deps.snapshotIntervalMs,
    autoTick: options.autoTick,
    hooks: {
      onEvents: (events) => recordEvents(deps, events),
      onSnapshot: (_factoryId, devices, capturedAt) =>
        simulationRepository.saveSnapshots(deps.db, devices.map(toSnapshotRow), capturedAt),
    },
  });

  const deviceIds = plan.devices.map((device) => device.id);
  await simulationRepository.setRuntimeStatus(deps.db, deviceIds, "RUNNING");
  await recordFactoryEvent(deps, factoryId, "SIMULATION_STARTED", {
    devices: deviceIds.length,
    signals: plan.bindings.length,
    plcs: plcs.size,
  });
  return { ...(await getSimulationState(deps, actor, factoryId)), skipped: plan.skipped };
}

/** Stops the simulation; the final device states are kept as snapshots. */
export async function stopFactorySimulation(deps: SimulationDeps, actor: Actor, factoryId: string): Promise<void> {
  if (!(await factoryRepository.findById(deps.db, actor.ownerId, factoryId))) throw notFound("factory");
  const devices = await deps.simulator.stop(factoryId);
  await simulationRepository.setRuntimeStatus(
    deps.db,
    devices.map((device) => device.deviceId),
    "STOPPED",
  );
  await recordFactoryEvent(deps, factoryId, "SIMULATION_STOPPED", { devices: devices.length });
}

/** Live device states, straight from simulator memory. */
export async function getSimulationState(
  deps: SimulationDeps,
  actor: Actor,
  factoryId: string,
): Promise<SimulationState> {
  if (!(await factoryRepository.findById(deps.db, actor.ownerId, factoryId))) throw notFound("factory");
  const status = deps.simulator.status(factoryId);
  return status ? { running: true, ...status } : { running: false };
}

/** Applies an operator action to a simulated device and records it. */
async function operate(
  deps: SimulationDeps,
  actor: Actor,
  deviceId: string,
  action: (simulation: ReturnType<DeviceSimulatorRuntime["simulation"]>) => SimEvent,
): Promise<DeviceSnapshot> {
  const device = await simulationRepository.findDeviceForOwner(deps.db, actor.ownerId, deviceId);
  if (!device) throw notFound("device");
  const simulation = deps.simulator.simulation(device.factoryId);
  if (!simulation.has(deviceId)) {
    throw new DomainError("INCOMPATIBLE", `${device.name} is not a simulated device.`, { rule: "simulated-device" });
  }
  const event = action(simulation);
  await deps.simulator.publish(device.factoryId, [{ ...event, payload: { ...event.payload, source: "UI" } }]);
  const snapshot = simulation.snapshot().find((candidate) => candidate.deviceId === deviceId);
  if (!snapshot) throw notFound("device");
  return snapshot;
}

export async function injectDeviceFault(deps: SimulationDeps, actor: Actor, deviceId: string, code: unknown) {
  const faultCode = parseInput(faultCodeSchema, code);
  return operate(deps, actor, deviceId, (simulation) => simulation.injectFault(deviceId, faultCode));
}

export async function clearDeviceFault(deps: SimulationDeps, actor: Actor, deviceId: string, code: unknown) {
  const faultCode = parseInput(faultCodeSchema, code);
  return operate(deps, actor, deviceId, (simulation) => simulation.clearFault(deviceId, faultCode));
}

/** Operator reset at the device. PLC logic can reset a device too, through its `faultReset` signal. */
export async function resetSimulatedDevice(deps: SimulationDeps, actor: Actor, deviceId: string) {
  return operate(deps, actor, deviceId, (simulation) => simulation.reset(deviceId));
}

/** Forces the value of a simulated sensor or switch; `null` releases it. */
export async function forceSimulatedValue(deps: SimulationDeps, actor: Actor, deviceId: string, value: unknown) {
  const forced = parseInput(forcedValueSchema, value);
  return operate(deps, actor, deviceId, (simulation) => simulation.setOverride(deviceId, forced));
}
