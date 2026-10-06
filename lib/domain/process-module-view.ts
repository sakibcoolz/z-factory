/**
 * Shapes the process-module service returns (docs/process-modules.md). Pure types;
 * importable anywhere.
 */
import type {
  InterlockExpression,
  ModuleConfigField,
  ModuleConfigValue,
  ModuleIssue,
  ModuleRole,
  ModuleSignal,
  SignalCounts,
} from "@/lib/domain/process-module";
import type { RuntimeState } from "@/lib/domain/runtime-state";

export type ModuleSeverity = "INFO" | "WARNING" | "CRITICAL";

export type ModuleTypeRef = { id: string; code: string; name: string; version: number };

export type ModuleTypeSummary = ModuleTypeRef & {
  description: string | null;
  /** The process model that simulates the type; null while there is none. */
  simulatorModelType: string | null;
  profiles: string[];
  /** False for a version a newer one has replaced. */
  latest: boolean;
  roleCount: number;
  /** Signals of the whole type, over all its profiles. */
  signalCounts: SignalCounts;
};

export type ModuleTypeDetail = ModuleTypeSummary & {
  configFields: ModuleConfigField[];
  roles: ModuleRole[];
  signals: ModuleSignal[];
};

/** A factory device in a role of a module. What the device is stays with the device. */
export type ModuleDeviceView = {
  assignmentId: string;
  deviceId: string;
  name: string;
  categoryCode: string;
  categoryName: string;
  manufacturer: string;
  modelName: string;
};

export type ModuleRoleView = ModuleRole & { devices: ModuleDeviceView[] };

export type ModuleInterlockView = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  severity: ModuleSeverity;
  enabled: boolean;
  expression: InterlockExpression;
};

export type ModuleSummary = {
  id: string;
  factoryId: string;
  name: string;
  location: string | null;
  /** Last stored state: RUNNING while the process bridge runs the module. */
  status: RuntimeState;
  profile: string | null;
  type: ModuleTypeRef;
  deviceCount: number;
  /** Signals of the selected profile. */
  signalCounts: SignalCounts;
  /** No issue: every required role is filled and every interlock is sound. Signals are counted below. */
  complete: boolean;
  issues: ModuleIssue[];
  /** The module's PLC bindings (TASK-605): accepted, no longer accepted, and required signals without one. */
  bindings: { bound: number; invalid: number; requiredUnbound: number };
  /** Complete, every required signal bound to an accepted tag, and a process model to run it. */
  readyToRun: boolean;
};

export type ModuleDetail = ModuleSummary & {
  config: Record<string, ModuleConfigValue>;
  configFields: ModuleConfigField[];
  /** The roles of the selected profile with the devices in them. */
  roles: ModuleRoleView[];
  /** The logical I/O contract of the selected profile. */
  signals: ModuleSignal[];
  interlocks: ModuleInterlockView[];
};
