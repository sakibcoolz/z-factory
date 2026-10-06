/**
 * The contract between Z-Factory and the process simulation service
 * (`services/process-sim`, ADR-0008, docs/process-simulation.md). Pure types and
 * constants; importable anywhere. The service validates everything again.
 */

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
  uptimeS: number;
  instances: number;
  modelTypes: string[];
};

export type ProcessSimMetrics = {
  instances: number;
  byStatus: Partial<Record<ProcessSimStatus, number>>;
  ticksTotal: number;
  lastTickMicros: number;
  modelTypes: string[];
};

/** The models the service ships, by the module type each one simulates (docs/process-simulation.md). */
export const PROCESS_SIM_MODELS: Readonly<Record<string, { modelType: string; modelVersion: number }>> = {
  PUMP_HOUSE: { modelType: "PUMP_HOUSE", modelVersion: 1 },
  TANK: { modelType: "TANK", modelVersion: 1 },
};
