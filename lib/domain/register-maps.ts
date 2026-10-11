/**
 * The declared register maps of protocol-controlled devices (TASK-1013): how a behaviour
 * profile's signals are exposed over a fieldbus. A map is a Z-Factory declaration for a
 * generic model; a vendor's map is catalog data with its provenance and is never guessed.
 * The Go runtime serves exactly what a map states (`services/process-sim/internal/device/
 * registers.go`), and the parity test holds the two descriptions together. Pure data;
 * importable anywhere.
 */
import {
  BEHAVIOR_PROFILES,
  type BehaviorFault,
  type BehaviorProfile,
  type BehaviorSignal,
  COMM_LOSS_FAULT,
} from "@/lib/domain/behavior-contract";
import type { ModbusArea, TagRole } from "@/lib/domain/tag";

export const REGISTER_PROTOCOLS = ["MODBUS_TCP"] as const;
export type RegisterProtocol = (typeof REGISTER_PROTOCOLS)[number];

/** The word types a single-register map entry may have. */
export type RegisterDataType = "BOOL" | "UINT16" | "INT16";

export type RegisterRange = { min?: number; max?: number; minParameter?: string; maxParameter?: string };

/** One signal of the profile at one area and address. */
export type RegisterSpec = {
  signal: string;
  area: ModbusArea;
  address: number;
  dataType: RegisterDataType;
  wordCount: 1;
  /** Engineering value = raw × scale + offset. */
  scale: number;
  offset: number;
  unit: string | null;
  /** READ_WRITE for a signal the PLC drives, READ_ONLY for one the device produces. */
  access: "READ_ONLY" | "READ_WRITE";
  /** The tag role the register would have in the PLC's registry. */
  role: TagRole;
  /** The engineering range a write must stay in; the signal's range, for a writable register. */
  range: RegisterRange | null;
};

export type RegisterMap = {
  key: string;
  version: number;
  protocol: RegisterProtocol;
  profile: string;
  profileVersion: number;
  summary: string;
  conventions: { addressing: "zero-based"; byteOrder: "BIG_ENDIAN"; wordOrder: "HIGH_WORD_FIRST" };
  registers: readonly RegisterSpec[];
  /** Faults a device gains by being served over the protocol (TASK-1014): COMM_LOSS. */
  faults: readonly BehaviorFault[];
};

export const MODBUS_CONVENTIONS = {
  addressing: "zero-based",
  byteOrder: "BIG_ENDIAN",
  wordOrder: "HIGH_WORD_FIRST",
} as const;

/** The area a signal lives in follows its direction and kind; a map cannot choose otherwise. */
export function areaOf(signal: Pick<BehaviorSignal, "direction" | "kind">): ModbusArea {
  if (signal.direction === "IN") return signal.kind === "BOOL" ? "COIL" : "HOLDING_REGISTER";
  return signal.kind === "BOOL" ? "DISCRETE_INPUT" : "INPUT_REGISTER";
}

const signalOf = (profile: BehaviorProfile, key: string): BehaviorSignal => {
  const signal = profile.signals.find((candidate) => candidate.key === key);
  if (!signal) throw new Error(`register map: ${profile.key} has no signal ${key}`);
  return signal;
};

/** A register for one signal of the profile: area, access and range follow from the signal. */
function register(
  profile: BehaviorProfile,
  key: string,
  address: number,
  role: TagRole,
  word: { dataType?: "UINT16" | "INT16"; scale?: number; offset?: number } = {},
): RegisterSpec {
  const signal = signalOf(profile, key);
  const bit = signal.kind === "BOOL";
  const range = signal.direction === "IN" && signal.range ? { ...signal.range } : null;
  return {
    signal: key,
    area: areaOf(signal),
    address,
    dataType: bit ? "BOOL" : (word.dataType ?? "UINT16"),
    wordCount: 1,
    scale: bit ? 1 : (word.scale ?? 1),
    offset: bit ? 0 : (word.offset ?? 0),
    unit: bit ? null : (signal.unit ?? null),
    access: signal.direction === "IN" ? "READ_WRITE" : "READ_ONLY",
    role,
    range,
  };
}

const VFD = BEHAVIOR_PROFILES.VFD!;

/**
 * The generic drive over Modbus TCP: Z-Factory's own map for the generic Modbus drive of
 * the catalog, not any vendor's. Commands are coils, the setpoint a holding register in
 * tenths of a hertz, boolean feedback discrete inputs, numeric feedback input registers
 * in tenths. The behaviour behind it is the VFD profile unchanged.
 */
const VFD_MODBUS_TCP: RegisterMap = {
  key: "VFD_MODBUS_TCP",
  version: 1,
  protocol: "MODBUS_TCP",
  profile: "VFD",
  profileVersion: 1,
  summary:
    "The generic drive over Modbus TCP: run, reverse and fault reset as coils, the frequency setpoint as a holding register in 0.1 Hz, running, at-setpoint and fault as discrete inputs, actual frequency and output current as input registers in 0.1 Hz and 0.1 A.",
  conventions: MODBUS_CONVENTIONS,
  faults: [COMM_LOSS_FAULT],
  registers: [
    register(VFD, "run", 0, "COMMAND"),
    register(VFD, "reverse", 1, "COMMAND"),
    register(VFD, "faultReset", 2, "COMMAND"),
    register(VFD, "frequencySetpoint", 0, "SETPOINT", { scale: 0.1 }),
    register(VFD, "running", 0, "STATUS"),
    register(VFD, "atSetpoint", 1, "STATUS"),
    register(VFD, "faulted", 2, "ALARM"),
    register(VFD, "actualFrequency", 0, "FEEDBACK", { scale: 0.1 }),
    register(VFD, "outputCurrent", 1, "FEEDBACK", { scale: 0.1 }),
  ],
};

export const REGISTER_MAPS: Readonly<Record<string, RegisterMap>> = { VFD_MODBUS_TCP };

export function findRegisterMap(key: string): RegisterMap | undefined {
  return REGISTER_MAPS[key];
}

const COMMAND_ROLES: ReadonlySet<TagRole> = new Set(["COMMAND", "SETPOINT"]);
const FEEDBACK_ROLES: ReadonlySet<TagRole> = new Set(["FEEDBACK", "STATUS", "ALARM", "PROCESS_VALUE"]);

/**
 * Why a map does not fit its profile, or null: every register names a signal of the
 * profile in the area its direction and kind dictate, with the access of its direction,
 * a fitting role, one address per area and one register per signal, a positive scale,
 * and a range only on a writable register naming parameters the profile has.
 */
export function checkRegisterMap(map: RegisterMap): string | null {
  const profile = BEHAVIOR_PROFILES[map.profile];
  if (!profile) return `profile ${map.profile} does not exist`;
  if (profile.version !== map.profileVersion) return `profile ${map.profile} is version ${profile.version}`;
  if (map.registers.length === 0) return "a map names at least one register";
  const taken = new Set<string>();
  for (const entry of map.registers) {
    const signal = profile.signals.find((candidate) => candidate.key === entry.signal);
    const where = `register ${entry.signal}`;
    if (!signal) return `${where} is not a signal of ${map.profile}`;
    if (entry.area !== areaOf(signal)) return `${where} lives in ${areaOf(signal)}, not ${entry.area}`;
    const bit = entry.area === "COIL" || entry.area === "DISCRETE_INPUT";
    if (bit !== (entry.dataType === "BOOL")) return `${where}: bit areas carry BOOL and register areas a word type`;
    if (entry.wordCount !== 1) return `${where}: only single-word registers are served`;
    if (entry.access !== (signal.direction === "IN" ? "READ_WRITE" : "READ_ONLY")) return `${where}: wrong access`;
    if (!(signal.direction === "IN" ? COMMAND_ROLES : FEEDBACK_ROLES).has(entry.role)) return `${where}: wrong role`;
    if (!(entry.scale > 0) || !Number.isFinite(entry.offset)) return `${where}: scale must be positive`;
    if (bit && (entry.scale !== 1 || entry.offset !== 0)) return `${where}: a bit is not scaled`;
    if (!Number.isInteger(entry.address) || entry.address < 0 || entry.address > 65535) return `${where}: address`;
    if (entry.range && signal.direction !== "IN") return `${where}: only a writable register has a range`;
    for (const parameter of [entry.range?.minParameter, entry.range?.maxParameter]) {
      if (parameter && !profile.parameters.some((candidate) => candidate.key === parameter)) {
        return `${where}: range names a parameter ${parameter} the profile does not have`;
      }
    }
    const slot = `${entry.area}:${entry.address}`;
    if (taken.has(slot)) return `${where}: ${slot} is used twice`;
    if (taken.has(`signal:${entry.signal}`)) return `${where}: the signal is mapped twice`;
    taken.add(slot);
    taken.add(`signal:${entry.signal}`);
  }
  return null;
}

/** A map as the runtime describes it: absent fields instead of nulls, for a field-by-field comparison. */
export function wireRegisterMap(map: RegisterMap): Record<string, unknown> {
  return {
    key: map.key,
    version: map.version,
    protocol: map.protocol,
    profile: map.profile,
    profileVersion: map.profileVersion,
    summary: map.summary,
    conventions: { ...map.conventions },
    faults: map.faults.map((fault) => ({
      code: fault.code,
      name: fault.name,
      severity: fault.severity,
      latching: fault.latching,
      ...(fault.silent ? { silent: true } : {}),
    })),
    registers: map.registers.map((entry) => {
      const wire: Record<string, unknown> = {
        signal: entry.signal,
        area: entry.area,
        address: entry.address,
        dataType: entry.dataType,
        wordCount: entry.wordCount,
        scale: entry.scale,
        offset: entry.offset,
        access: entry.access,
        role: entry.role,
      };
      if (entry.unit) wire.unit = entry.unit;
      if (entry.range) {
        const range: Record<string, unknown> = {};
        if (entry.range.min !== undefined) range.min = entry.range.min;
        if (entry.range.max !== undefined) range.max = entry.range.max;
        if (entry.range.minParameter) range.minParameter = entry.range.minParameter;
        if (entry.range.maxParameter) range.maxParameter = entry.range.maxParameter;
        wire.range = range;
      }
      return wire;
    }),
  };
}
