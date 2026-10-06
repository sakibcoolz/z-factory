/**
 * The closed loop between a process module and its PLC (TASK-603, docs/process-simulation.md
 * → Bridge). A module signal is carried by one PLC tag: what the PLC program writes
 * (module OUTPUT signals: commands and setpoints) becomes an input of the process model,
 * what the model produces (module INPUT and ALARM signals) is written back as feedback.
 *
 * Pure rules over a module type's signals and the tags they are mapped to. The registry
 * that stores mappings is TASK-605; whoever supplies them, these rules decide whether the
 * bridge accepts them. The PLC program stays the control authority: the bridge only
 * reads tags PLC logic drives and only writes memory addresses nothing else owns.
 */
import { DomainError } from "@/lib/domain/errors";
import { appliesToProfile, type ModuleSignal, type ModuleSignalDirection } from "@/lib/domain/process-module";
import type { AccessMode, ModbusArea, TagDataType, TagRole } from "@/lib/domain/tag";
import { wordCountFor } from "@/lib/domain/tag";

/** The tag a module signal is mapped to, with everything the rules and the bridge need. */
export type ProcessSignalTag = {
  id: string;
  plcId: string;
  name: string;
  dataType: TagDataType;
  role: TagRole;
  accessMode: AccessMode;
  /** IEC located address, e.g. `%MW10`; null for a tag without one. */
  logicalAddress: string | null;
  protocolArea: ModbusArea | null;
  /** Zero-based address within the area. */
  protocolAddress: number | null;
  wordCount: number;
  byteOrder: "BIG_ENDIAN" | "LITTLE_ENDIAN";
  wordOrder: "HIGH_WORD_FIRST" | "LOW_WORD_FIRST";
  scale: number;
  offset: number;
  unit: string | null;
  /** A tag that already carries a device signal (docs/device-simulation.md) is taken. */
  sourceDeviceInstanceId: string | null;
};

/** One module signal mapped to one tag. */
export type ProcessMapping = { signalKey: string; tag: ProcessSignalTag };

export type ProcessMappingRule =
  | "module-signal-unknown"
  | "module-signal-direction"
  | "module-signal-profile"
  | "signal-plc-driven"
  | "signal-address"
  | "signal-data-type"
  | "signal-range"
  | "signal-unit"
  | "modbus-mapping"
  | "tag-in-use"
  | "duplicate-signal"
  | "duplicate-tag"
  | "address-overlap"
  | "required-signal";

/** The live quality of a module's values (docs/events-telemetry.md → Quality). */
export type ProcessQuality = "GOOD" | "STALE" | "DISCONNECTED";

/** How the bridge carries a module signal: into the process model, or out of it to the PLC. */
export type ProcessFlow = "INTO_PROCESS" | "TO_PLC";

export function processFlow(direction: ModuleSignalDirection): ProcessFlow | null {
  if (direction === "OUTPUT") return "INTO_PROCESS";
  if (direction === "INPUT" || direction === "ALARM") return "TO_PLC";
  return null;
}

const refuse = (
  code: "VALIDATION" | "INCOMPATIBLE" | "CONFLICT",
  message: string,
  rule: ProcessMappingRule,
  extra = {},
) => new DomainError(code, message, { rule, ...extra });

/** The region of a located address: `%QX0.1` → `Q`. */
export function locatedRegion(logicalAddress: string | null): "I" | "Q" | "M" | null {
  const match = /^%([IQM])/i.exec(logicalAddress?.trim() ?? "");
  return match ? (match[1]!.toUpperCase() as "I" | "Q" | "M") : null;
}

/** Raw ranges of the register types; the codec (lib/protocols/modbus/codec.ts) encodes within them. */
const RAW_RANGE: Record<Exclude<TagDataType, "BOOL" | "FLOAT32">, readonly [number, number]> = {
  INT16: [-32768, 32767],
  UINT16: [0, 65535],
  INT32: [-2147483648, 2147483647],
  UINT32: [0, 4294967295],
};

/** The engineering values a tag can carry: raw × scale + offset over the raw range. */
export function tagEngineeringRange(tag: Pick<ProcessSignalTag, "dataType" | "scale" | "offset">): [number, number] {
  if (tag.dataType === "BOOL") return [0, 1];
  if (tag.dataType === "FLOAT32") return [-Infinity, Infinity];
  const [min, max] = RAW_RANGE[tag.dataType];
  const a = min * tag.scale + tag.offset;
  const b = max * tag.scale + tag.offset;
  return a <= b ? [a, b] : [b, a];
}

/**
 * Whether one signal may be carried by one tag. Throws the first rule that is broken.
 * A tag the program drives is READ_ONLY (no gateway writes it, ADR-0006); a command into
 * the process is read from %Q or %M; feedback is delivered to %M only, because the
 * runtime's Modbus server does not accept writes to %I or %Q (ADR-0009).
 */
export function checkProcessMapping(signal: ModuleSignal, tag: ProcessSignalTag): ProcessFlow {
  const flow = processFlow(signal.direction);
  if (!flow) {
    throw refuse(
      "INCOMPATIBLE",
      `${signal.name} is internal to the process model; it is not carried by a tag.`,
      "module-signal-direction",
      {
        signal: signal.key,
      },
    );
  }
  if (tag.protocolArea === null || tag.protocolAddress === null) {
    throw refuse("INCOMPATIBLE", `Tag ${tag.name} has no Modbus mapping.`, "modbus-mapping", { tag: tag.name });
  }
  if (tag.sourceDeviceInstanceId) {
    throw refuse("CONFLICT", `Tag ${tag.name} already carries a device signal.`, "tag-in-use", { tag: tag.name });
  }
  if (tag.accessMode !== "READ_ONLY") {
    throw refuse(
      "INCOMPATIBLE",
      `Tag ${tag.name} can be written by a gateway. A process is wired to what the PLC program computes; use a tag with a role other than COMMAND or SETPOINT.`,
      "signal-plc-driven",
      { tag: tag.name },
    );
  }
  const region = locatedRegion(tag.logicalAddress);
  if (flow === "INTO_PROCESS" && region !== "Q" && region !== "M") {
    throw refuse(
      "INCOMPATIBLE",
      `${signal.name} is driven by the program: map it to a PLC output (%Q) or memory (%M) address, not ${tag.logicalAddress ?? "a tag without a located address"}.`,
      "signal-address",
      { signal: signal.key, tag: tag.name },
    );
  }
  if (flow === "TO_PLC" && region !== "M") {
    throw refuse(
      "INCOMPATIBLE",
      `${signal.name} is process feedback: it can only be delivered to a memory (%M) address; the runtime does not accept values on %I or %Q.`,
      "signal-address",
      { signal: signal.key, tag: tag.name },
    );
  }
  if ((signal.dataType === "BOOL") !== (tag.dataType === "BOOL")) {
    throw refuse(
      "INCOMPATIBLE",
      signal.dataType === "BOOL"
        ? `${signal.name} is on/off and needs a BOOL tag; ${tag.name} is ${tag.dataType}.`
        : `${signal.name} is a number and needs a numeric tag; ${tag.name} is BOOL.`,
      "signal-data-type",
      { signal: signal.key, tag: tag.name },
    );
  }
  if (signal.dataType !== "BOOL") {
    const [min, max] = tagEngineeringRange(tag);
    const low = signal.rangeMin ?? min;
    const high = signal.rangeMax ?? max;
    if (low < min || high > max) {
      throw refuse(
        "INCOMPATIBLE",
        `${signal.name} ranges ${low} to ${high}${signal.unit ? ` ${signal.unit}` : ""}; tag ${tag.name} (${tag.dataType}, scale ${tag.scale}, offset ${tag.offset}) carries ${min} to ${max}.`,
        "signal-range",
        { signal: signal.key, tag: tag.name },
      );
    }
  }
  if (signal.unit && tag.unit && signal.unit !== tag.unit) {
    throw refuse(
      "INCOMPATIBLE",
      `${signal.name} is in ${signal.unit}; tag ${tag.name} is in ${tag.unit}.`,
      "signal-unit",
      { signal: signal.key, tag: tag.name },
    );
  }
  return flow;
}

export type ProcessMappingIssue = { rule: ProcessMappingRule; message: string; signalKey: string | null };

/**
 * Checks a module's whole set of mappings: every mapping against its signal, then the set
 * for duplicates and overlapping registers. Returns the issues instead of throwing, so a
 * screen can show them all; `required-signal` issues name the signals a complete module
 * still needs before it can run.
 */
export function checkProcessMappings(
  signals: readonly ModuleSignal[],
  mappings: readonly ProcessMapping[],
  options: { profile?: string | null } = {},
): ProcessMappingIssue[] {
  const issues: ProcessMappingIssue[] = [];
  const byKey = new Map(signals.map((signal) => [signal.key, signal]));
  const seenSignals = new Set<string>();
  const seenTags = new Map<string, string>();
  const accepted: Array<{ signalKey: string; tag: ProcessSignalTag }> = [];

  for (const mapping of mappings) {
    const signal = byKey.get(mapping.signalKey);
    if (!signal) {
      issues.push({
        rule: "module-signal-unknown",
        signalKey: mapping.signalKey,
        message: `The module type has no signal ${mapping.signalKey}.`,
      });
      continue;
    }
    if (!appliesToProfile(signal, options.profile ?? null)) {
      issues.push({
        rule: "module-signal-profile",
        signalKey: signal.key,
        message: `${signal.name} does not exist in the selected profile.`,
      });
      continue;
    }
    if (seenSignals.has(signal.key)) {
      issues.push({ rule: "duplicate-signal", signalKey: signal.key, message: `${signal.name} is mapped twice.` });
      continue;
    }
    seenSignals.add(signal.key);
    const other = seenTags.get(mapping.tag.id);
    if (other) {
      issues.push({
        rule: "duplicate-tag",
        signalKey: signal.key,
        message: `Tag ${mapping.tag.name} carries ${other} already.`,
      });
      continue;
    }
    seenTags.set(mapping.tag.id, signal.key);
    try {
      checkProcessMapping(signal, mapping.tag);
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      issues.push({ rule: error.details.rule as ProcessMappingRule, signalKey: signal.key, message: error.message });
      continue;
    }
    for (const earlier of accepted) {
      if (overlaps(earlier.tag, mapping.tag)) {
        issues.push({
          rule: "address-overlap",
          signalKey: signal.key,
          message: `Tag ${mapping.tag.name} overlaps tag ${earlier.tag.name} in ${mapping.tag.protocolArea}.`,
        });
      }
    }
    accepted.push({ signalKey: signal.key, tag: mapping.tag });
  }

  for (const signal of signals) {
    if (!signal.required || !processFlow(signal.direction) || !appliesToProfile(signal, options.profile ?? null))
      continue;
    if (!seenSignals.has(signal.key)) {
      issues.push({ rule: "required-signal", signalKey: signal.key, message: `${signal.name} is not mapped.` });
    }
  }
  return issues;
}

/** Two tags of one PLC whose registers (or bits) share an address. */
function overlaps(a: ProcessSignalTag, b: ProcessSignalTag): boolean {
  if (a.plcId !== b.plcId || a.protocolArea !== b.protocolArea) return false;
  if (a.protocolAddress === null || b.protocolAddress === null) return false;
  const aEnd = a.protocolAddress + Math.max(a.wordCount, wordCountFor(a.dataType)) - 1;
  const bEnd = b.protocolAddress + Math.max(b.wordCount, wordCountFor(b.dataType)) - 1;
  return a.protocolAddress <= bEnd && b.protocolAddress <= aEnd;
}

/** A process value as the PLC bridge carries it: numbers stay numbers, on/off becomes 1/0. */
export function toModelValue(value: number | boolean | undefined): number {
  if (typeof value === "boolean") return value ? 1 : 0;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** A model output as the PLC bridge encodes it: BOOL signals are true above zero. */
export function fromModelValue(value: number | undefined, dataType: TagDataType): number | boolean {
  const number = typeof value === "number" && Number.isFinite(value) ? value : 0;
  return dataType === "BOOL" ? number !== 0 : number;
}
