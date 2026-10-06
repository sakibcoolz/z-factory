/**
 * Shapes of the module PLC I/O registry (TASK-605, docs/process-modules.md → Module PLC I/O
 * Registry): what a module consumes of its PLCs, signal by signal. Pure types and the
 * rules that build the registry from a module's signals and stored bindings; importable
 * anywhere.
 */
import {
  checkProcessMappings,
  type ProcessMappingRule,
  type ProcessSignalTag,
  processFlow,
} from "@/lib/domain/process-bridge";
import { appliesToProfile, type ModuleSignal, type ModuleSignalDirection } from "@/lib/domain/process-module";
import type { ModbusArea, TagDataType } from "@/lib/domain/tag";

/** The PLC endpoint a signal is bound to: a tag with its located address and Modbus mapping. */
export type ModuleBindingView = {
  mappingId: string;
  plcId: string;
  plcName: string;
  tagId: string;
  tagName: string;
  logicalAddress: string | null;
  dataType: TagDataType;
  modbusArea: ModbusArea | null;
  /** Zero-based address within the area. */
  modbusAddress: number | null;
  scale: number;
  offset: number;
  unit: string | null;
  /** The PLC I/O point the tag sits on, when it is a channel rather than memory. */
  ioPointId: string | null;
};

export type ModuleIoState =
  /** Bound to a tag the rules accept. */
  | "BOUND"
  /** Bound to a tag the rules no longer accept (the tag changed, or a second module took it). */
  | "INVALID"
  /** Not bound; `blocking` says whether that keeps the module from running. */
  | "UNBOUND";

export type ModuleIoRow = {
  signal: ModuleSignal;
  state: ModuleIoState;
  /** A required signal without an accepted binding: the module cannot run. */
  blocking: boolean;
  issue: { rule: ProcessMappingRule; message: string } | null;
  binding: ModuleBindingView | null;
};

export type ModuleIoCounts = Record<
  Exclude<ModuleSignalDirection, "INTERNAL">,
  { total: number; bound: number; invalid: number; requiredUnbound: number }
>;

/** What one module takes of one PLC. */
export type ModulePlcUse = { plcId: string; plcName: string; inputs: number; outputs: number; alarms: number };

export type ModuleIoRegistry = {
  moduleId: string;
  name: string;
  profile: string | null;
  type: { code: string; name: string; version: number; simulatorModelType: string | null };
  /** Complete, every required signal of the profile bound to an accepted tag, and a process model to run it. */
  readyToRun: boolean;
  /** Every signal of the profile the PLC can carry, in the type's order; INTERNAL signals are not consumed. */
  rows: ModuleIoRow[];
  internal: ModuleSignal[];
  counts: ModuleIoCounts;
  plcs: ModulePlcUse[];
};

/** A tag of the factory as a candidate for one signal, with why it cannot be used when it cannot. */
export type ModuleIoCandidate = {
  tagId: string;
  plcId: string;
  plcName: string;
  tagName: string;
  logicalAddress: string | null;
  dataType: TagDataType;
  role: string;
  unit: string | null;
  /** Null when the tag may be bound to the signal. */
  refusal: { rule: ProcessMappingRule | "tag-mapped"; message: string } | null;
  /** The module and signal the tag already carries, when it does. */
  heldBy: { module: string; signal: string } | null;
};

export type StoredModuleBinding = {
  mappingId: string;
  signalKey: string;
  plcName: string;
  tag: ProcessSignalTag;
  ioPointId: string | null;
};

const consumed = (direction: ModuleSignalDirection) => processFlow(direction) !== null;

/**
 * Builds the registry rows from the signals of the module's profile and its stored
 * bindings. A binding is re-checked every time: a tag that was fine when it was bound and
 * no longer is (its role changed, it was given to a device) shows as INVALID instead of
 * silently feeding the bridge.
 */
export function buildModuleIo(
  signals: readonly ModuleSignal[],
  profile: string | null,
  bindings: readonly StoredModuleBinding[],
): Pick<ModuleIoRegistry, "rows" | "internal" | "counts" | "plcs"> & { blocking: boolean } {
  const inProfile = signals.filter((signal) => appliesToProfile(signal, profile));
  const issues = checkProcessMappings(
    signals,
    bindings.map((binding) => ({ signalKey: binding.signalKey, tag: binding.tag })),
    { profile },
  );
  const bySignal = new Map(bindings.map((binding) => [binding.signalKey, binding]));

  const rows: ModuleIoRow[] = inProfile
    .filter((signal) => consumed(signal.direction))
    .map((signal) => {
      const binding = bySignal.get(signal.key);
      const issue = issues.find(
        (candidate) => candidate.signalKey === signal.key && candidate.rule !== "required-signal",
      );
      const view: ModuleBindingView | null = binding
        ? {
            mappingId: binding.mappingId,
            plcId: binding.tag.plcId,
            plcName: binding.plcName,
            tagId: binding.tag.id,
            tagName: binding.tag.name,
            logicalAddress: binding.tag.logicalAddress,
            dataType: binding.tag.dataType,
            modbusArea: binding.tag.protocolArea,
            modbusAddress: binding.tag.protocolAddress,
            scale: binding.tag.scale,
            offset: binding.tag.offset,
            unit: binding.tag.unit,
            ioPointId: binding.ioPointId,
          }
        : null;
      const state: ModuleIoState = !binding ? "UNBOUND" : issue ? "INVALID" : "BOUND";
      return {
        signal,
        state,
        blocking: signal.required && state !== "BOUND",
        issue: issue ? { rule: issue.rule, message: issue.message } : null,
        binding: view,
      };
    });

  const counts: ModuleIoCounts = {
    INPUT: { total: 0, bound: 0, invalid: 0, requiredUnbound: 0 },
    OUTPUT: { total: 0, bound: 0, invalid: 0, requiredUnbound: 0 },
    ALARM: { total: 0, bound: 0, invalid: 0, requiredUnbound: 0 },
  };
  const plcs = new Map<string, ModulePlcUse>();
  for (const row of rows) {
    if (row.signal.direction === "INTERNAL") continue;
    const count = counts[row.signal.direction];
    count.total += 1;
    if (row.state === "BOUND") count.bound += 1;
    if (row.state === "INVALID") count.invalid += 1;
    if (row.state === "UNBOUND" && row.signal.required) count.requiredUnbound += 1;
    if (row.binding && row.state === "BOUND") {
      const use = plcs.get(row.binding.plcId) ?? {
        plcId: row.binding.plcId,
        plcName: row.binding.plcName,
        inputs: 0,
        outputs: 0,
        alarms: 0,
      };
      if (row.signal.direction === "INPUT") use.inputs += 1;
      else if (row.signal.direction === "OUTPUT") use.outputs += 1;
      else use.alarms += 1;
      plcs.set(row.binding.plcId, use);
    }
  }

  return {
    rows,
    internal: inProfile.filter((signal) => signal.direction === "INTERNAL"),
    counts,
    plcs: [...plcs.values()].sort((a, b) => a.plcName.localeCompare(b.plcName)),
    blocking: rows.some((row) => row.blocking),
  };
}

export const MODULE_IO_EXPORT_SCHEMA = "z-factory.module-io";
export const MODULE_IO_EXPORT_SCHEMA_VERSION = 1;

/** The bindings of a module as a document that another installation reconstructs by names. */
export type ModuleIoExportDocument = {
  schema: typeof MODULE_IO_EXPORT_SCHEMA;
  schemaVersion: typeof MODULE_IO_EXPORT_SCHEMA_VERSION;
  generatedAt: string;
  module: { name: string; type: string; version: number; profile: string | null };
  bindings: Array<{
    signal: string;
    direction: ModuleSignalDirection;
    plc: string;
    tag: string;
    logicalAddress: string | null;
    dataType: TagDataType;
  }>;
};
