/**
 * The contract between Z-Factory and the process simulation service
 * (`services/process-sim`, ADR-0008, docs/process-simulation.md). Pure types and
 * constants; importable anywhere. The service validates everything again.
 */
import { BEHAVIOR_PROFILES, type BehaviorParameter, wireParameter } from "@/lib/domain/behavior-contract";

/** The version of the configuration contract the service speaks. */
export const PROCESS_SIM_CONTRACT_VERSION = 1;

/** What advances an instance: wall time at its tick rate, or manual steps only (tests, the bridge). */
export type ProcessSimClock = "wall" | "manual";

export type ProcessSimStatus = "LOADED" | "RUNNING" | "STOPPED" | "FAULTED";

/** The configuration of one instance, as the service loads it. */
export type ProcessSimConfig = {
  contractVersion: typeof PROCESS_SIM_CONTRACT_VERSION;
  /** Z-Factory's id of the instance: the process module instance it stands for. */
  instanceId: string;
  factoryId: string;
  /** The process-module type the instance was created from. */
  moduleType: string;
  /** The service's model that simulates it, and the version of its equations. */
  modelType: string;
  modelVersion: number;
  /** The version of this configuration in Z-Factory; a changed configuration is a new version. */
  configVersion: number;
  /** Simulated time per tick; 10 to 10000. */
  tickMs: number;
  clock: ProcessSimClock;
  parameters: Record<string, number>;
  /** Initial inputs; the model's other inputs are zero. */
  inputs?: Record<string, number>;
};

export type ProcessSimEvent = {
  seq: number;
  tick: number;
  timeS: number;
  type: string;
  message: string;
  values?: Record<string, number>;
};

/** Where a measured output's value comes from (Phase 08, TASK-801). */
export type ProcessSimMode = "AUTO" | "MANUAL_OVERRIDE" | "SCENARIO";

/** A SCENARIO value over simulated time: a ramp (then held) or steps at offsets. */
export type ProcessSimProfile =
  | { kind: "RAMP"; from: number; to: number; durationS: number }
  | { kind: "STEPS"; steps: Array<{ atS: number; value: number }> };

export type ProcessSimOverrideRequest =
  | { mode: "AUTO"; source?: string }
  | { mode: "MANUAL_OVERRIDE"; value: number; source?: string }
  | { mode: "SCENARIO"; profile: ProcessSimProfile; source?: string };

/** One measured output: where its value comes from, what the model calculates, what is delivered. */
export type ProcessSimSignalState = {
  signal: string;
  unit: string;
  bool: boolean;
  min: number;
  max: number;
  mode: ProcessSimMode;
  calculated: number;
  effective: number;
  value?: number;
  profile?: ProcessSimProfile;
  sinceTick: number;
  sinceTimeS: number;
  source?: string;
};

/** What inspecting an instance returns. */
export type ProcessSimSnapshot = {
  instanceId: string;
  factoryId: string;
  moduleType: string;
  modelType: string;
  modelVersion: number;
  configVersion: number;
  tickMs: number;
  clock: ProcessSimClock;
  status: ProcessSimStatus;
  tick: number;
  timeS: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  state: Record<string, number>;
  lastEventSeq: number;
  /** Overridden measured outputs; `outputs` already carry their effective values. */
  overrides?: ProcessSimSignalState[];
  error?: string;
  loadedAt: string;
};

export type ProcessSimHealth = {
  status: "ok";
  version: string;
  contractVersion: number;
  /** The device runtime's contract (TASK-1009). */
  deviceContractVersion: number;
  uptimeS: number;
  instances: number;
  modelTypes: string[];
  factories: number;
  devices: number;
  profiles: string[];
  /** The declared register maps the runtime serves (TASK-1013). */
  registerMaps?: string[];
};

export type ProcessSimMetrics = {
  instances: number;
  byStatus: Partial<Record<ProcessSimStatus, number>>;
  ticksTotal: number;
  lastTickMicros: number;
  modelTypes: string[];
  /** The device runtime's counters (TASK-1009). */
  devices: DeviceSimMetrics;
};

/** The models the service ships, by the module type each one simulates (docs/process-simulation.md). */
export const PROCESS_SIM_MODELS: Readonly<Record<string, { modelType: string; modelVersion: number }>> = {
  PUMP_HOUSE: { modelType: "PUMP_HOUSE", modelVersion: 1 },
  TANK: { modelType: "TANK", modelVersion: 1 },
};

// ----- The catalog device runtime (TASK-1009) ---------------------------------------------

/** The version of the device configuration contract the service's runtime speaks. */
export const DEVICE_SIM_CONTRACT_VERSION = 1;

export type DeviceSimStatus = "LOADED" | "RUNNING" | "STOPPED";

/** A device in the runtime: OK, FAULTED (its behaviour failed in a step) or QUARANTINED (it overran its step budget). */
export type DeviceSimDeviceStatus = "OK" | "FAULTED" | "QUARANTINED";

export type DeviceSimSignal = {
  key: string;
  direction: "IN" | "OUT";
  kind: "BOOL" | "NUMBER";
  label: string;
  unit?: string;
};

export type DeviceSimFault = {
  code: string;
  name: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  latching: boolean;
  silent?: boolean;
};

/** What a behaviour profile declares about itself: the stable contract the catalog reads. */
export type DeviceSimProfile = {
  key: string;
  version: number;
  summary: string;
  signals: DeviceSimSignal[];
  faults: DeviceSimFault[];
  links?: Array<{ role: string; accepts?: string[]; meaning: string }>;
  /** The generic defaults, as a parameter body the runtime accepts. */
  parameters: unknown;
  /** The machine-readable parameter schema (TASK-1010): `wireParameter` of each contract parameter. */
  parameterSchema: Array<ReturnType<typeof wireParameter>>;
  states: string[];
  forcible: boolean;
  forcedKind?: "BOOL" | "NUMBER";
};

/**
 * How a protocol-controlled device is served to the PLC (TASK-1013): the protocol, the
 * unit id the PLC addresses it by, and the declared register map it exposes.
 */
export type DeviceSimProtocolConfig = {
  kind: "MODBUS_TCP";
  unitId: number;
  registerMap: string;
  registerMapVersion: number;
};

/** A declared register map as the runtime describes it (`wireRegisterMap` of the contract). */
export type DeviceSimRegisterMap = {
  key: string;
  version: number;
  protocol: string;
  profile: string;
  profileVersion: number;
  summary: string;
  conventions: { addressing: string; byteOrder: string; wordOrder: string };
  registers: Array<Record<string, unknown>>;
};

/** One device as the runtime takes it. Values are numbers; a BOOL travels as 0 or 1. */
export type DeviceSimDeviceConfig = {
  deviceId: string;
  name: string;
  /** The behaviour profile, from the catalog's simulation metadata (`DEVICE_PROFILES`). */
  profile: string;
  profileVersion: number;
  /** The profile's parameters; absent ones take the generic defaults. */
  parameters?: unknown;
  /** The catalog's overrides of the profile's generic faults. */
  faults?: Record<string, { severity?: DeviceSimFault["severity"]; latching?: boolean }>;
  /** Links to other devices of the factory by role: `drive`, `motor`, `measures`. */
  links?: Record<string, string>;
  inputs?: Record<string, number>;
  /** Served over a protocol at a unit id with a declared register map (TASK-1013). */
  protocol?: DeviceSimProtocolConfig;
};

export type DeviceSimConfig = {
  contractVersion: typeof DEVICE_SIM_CONTRACT_VERSION;
  factoryId: string;
  configVersion: number;
  tickMs: number;
  clock: ProcessSimClock;
  devices: DeviceSimDeviceConfig[];
  /** A Modbus TCP listener for the factory's protocol devices; port 0 takes any free port of the runtime's range. */
  modbusTcp?: { port: number };
};

export type DeviceSimDeviceSnapshot = {
  deviceId: string;
  name: string;
  profile: string;
  profileVersion: number;
  status: DeviceSimDeviceStatus;
  state: string;
  faulted: boolean;
  tripped: boolean;
  activeFaults: string[];
  quality: "GOOD" | "BAD";
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  forced?: number;
  internal: Record<string, number>;
  error?: string;
  protocol?: DeviceSimProtocolConfig;
};

export type DeviceSimSummary = {
  factoryId: string;
  configVersion: number;
  tickMs: number;
  clock: ProcessSimClock;
  status: DeviceSimStatus;
  tick: number;
  timeS: number;
  deviceCount: number;
  devicesByStatus: Partial<Record<DeviceSimDeviceStatus, number>>;
  lastEventSeq: number;
  loadedAt: string;
  /** A wall-clock factory that is RUNNING but has not ticked for five ticks. */
  stalled: boolean;
  /** Where the factory's protocol devices are served; absent without a listener (TASK-1013). */
  modbusTcp?: { address: string; port: number; devices: number };
};

export type DeviceSimSnapshot = DeviceSimSummary & { devices: DeviceSimDeviceSnapshot[] };

export type DeviceSimEvent = {
  seq: number;
  tick: number;
  timeS: number;
  type: string;
  deviceId: string;
  severity: DeviceSimFault["severity"];
  payload?: Record<string, unknown>;
};

export type DeviceSimMetrics = {
  factories: number;
  factoriesByStatus: Partial<Record<DeviceSimStatus, number>>;
  devices: number;
  devicesByStatus: Partial<Record<DeviceSimDeviceStatus, number>>;
  maxDevices: number;
  ticksTotal: number;
  lastTickMicros: number;
  stalled: number;
  profiles: string[];
};

/**
 * The behaviour profile of each simulated catalog type (`SimulatorType`), derived from the
 * behaviour contract: the catalog's simulation metadata selects the behaviour, never a
 * condition in the UI.
 */
export const DEVICE_PROFILES: Readonly<Record<string, { profile: string; profileVersion: number }>> =
  Object.fromEntries(
    Object.values(BEHAVIOR_PROFILES).map((profile) => [
      profile.simulatorType,
      { profile: profile.key, profileVersion: profile.version },
    ]),
  );

/** The parameter schema of a profile as the runtime describes it, for the parity check. */
export function expectedParameterSchema(parameters: readonly BehaviorParameter[]) {
  return parameters.map(wireParameter);
}
