/**
 * What the process-module screens show (TASK-604, docs/design.md → Process module UX).
 * Pure types; importable anywhere. The data comes from the module service and the module
 * I/O registry; nothing here is invented by the UI.
 */
import type { ModuleIoCandidate, ModuleIoRegistry } from "@/lib/domain/module-io-view";
import type { ModuleDetail, ModuleTypeDetail } from "@/lib/domain/process-module-view";
import type { ProcessQuality } from "@/lib/domain/process-bridge";
import type { ProcessSimStatus } from "@/lib/domain/process-sim";

/** A factory device that can fill a role: category accepted, not yet in that role. */
export type AssignableDevice = {
  deviceId: string;
  name: string;
  categoryCode: string;
  categoryName: string;
  modelName: string;
};

/** A PLC of the factory as the topology section draws it. */
export type ModulePlcNode = { plcId: string; name: string; signals: number };

/** The module as the process bridge runs it now, or null while it does not. */
export type ModuleRuntimeView = {
  bridgeRunning: boolean;
  status: ProcessSimStatus | "UNAVAILABLE" | null;
  quality: ProcessQuality | null;
  tick: number;
  timeS: number;
  inputs: Record<string, number>;
  outputs: Record<string, number>;
  alarms: string[];
  plcs: Array<{ plcId: string; up: boolean | null }>;
  error: string | null;
  /** Null when the simulation service is configured; else why nothing can run. */
  serviceNote: string | null;
};

export type ModuleDesignerView = {
  factory: { id: string; name: string };
  module: ModuleDetail;
  type: ModuleTypeDetail;
  registry: ModuleIoRegistry;
  /** Per signal key of the registry's rows: every tag with its refusal, for the picker. */
  candidates: Record<string, ModuleIoCandidate[]>;
  /** Per role key: the factory devices that could be assigned to it. */
  assignable: Record<string, AssignableDevice[]>;
  plcs: ModulePlcNode[];
  runtime: ModuleRuntimeView;
};

/** What the module list and the new-module form need. */
export type ModulesScreenView = {
  factory: { id: string; name: string };
  modules: ModuleDetail[];
  /** The newest version of every type, with its profiles and settings for the form. */
  types: ModuleTypeDetail[];
};
