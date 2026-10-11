/**
 * Device-simulation vocabulary (docs/device-simulation.md): which device types the shared
 * simulator models, the signals each exchanges with a PLC, and the faults it supports.
 * Pure data; importable anywhere.
 *
 * These are generic simulation behaviours. They make no claim about any vendor's device.
 */

export type Severity = "INFO" | "WARNING" | "CRITICAL";

/** Simulator types with a behaviour model. Other `SimulatorType` values are not simulated. */
export const SIMULATED_TYPES = [
  "VFD",
  "MOTOR",
  "PUMP",
  "FAN",
  "CONVEYOR",
  "MIXER",
  "COMPRESSOR",
  "VALVE",
  "SENSOR",
  "SWITCH",
] as const;
export type SimulatedType = (typeof SIMULATED_TYPES)[number];

export function isSimulatedType(type: string): type is SimulatedType {
  return (SIMULATED_TYPES as readonly string[]).includes(type);
}

/** Motor-driven equipment: its behaviour follows the speed of the motor that drives it. */
export const LOAD_TYPES = ["PUMP", "FAN", "CONVEYOR", "MIXER", "COMPRESSOR"] as const;
export type LoadType = (typeof LOAD_TYPES)[number];

export function isLoadType(type: string): type is LoadType {
  return (LOAD_TYPES as readonly string[]).includes(type);
}

export type SignalKind = "BOOL" | "NUMBER";
/** IN: the device consumes it from PLC logic. OUT: the device produces it for the PLC. */
export type SignalDirection = "IN" | "OUT";

export type SignalDefinition = {
  key: string;
  direction: SignalDirection;
  kind: SignalKind;
  label: string;
  /** Engineering unit of the simulated value; the tag's scale converts it to the PLC's raw value. */
  unit?: string;
};

const input = (key: string, kind: SignalKind, label: string, unit?: string): SignalDefinition => ({
  key,
  direction: "IN",
  kind,
  label,
  unit,
});
const output = (key: string, kind: SignalKind, label: string, unit?: string): SignalDefinition => ({
  key,
  direction: "OUT",
  kind,
  label,
  unit,
});

const RUNNING = output("running", "BOOL", "Running");
const FAULTED = output("faulted", "BOOL", "Fault active");
const FAULT_RESET = input("faultReset", "BOOL", "Fault reset (rising edge)");
const GENERIC_LOAD = [RUNNING, FAULTED, output("output", "NUMBER", "Output")] as const;

export const DEVICE_SIGNALS: Record<SimulatedType, readonly SignalDefinition[]> = {
  VFD: [
    input("run", "BOOL", "Run command"),
    input("reverse", "BOOL", "Reverse direction"),
    input("frequencySetpoint", "NUMBER", "Frequency setpoint", "Hz"),
    FAULT_RESET,
    RUNNING,
    output("atSetpoint", "BOOL", "At setpoint"),
    FAULTED,
    output("actualFrequency", "NUMBER", "Actual frequency", "Hz"),
    output("outputCurrent", "NUMBER", "Output current", "A"),
  ],
  MOTOR: [
    input("run", "BOOL", "Contactor command (motors without a drive)"),
    FAULT_RESET,
    RUNNING,
    FAULTED,
    output("actualSpeed", "NUMBER", "Actual speed", "rpm"),
    output("current", "NUMBER", "Current", "A"),
  ],
  PUMP: [RUNNING, FAULTED, output("flow", "NUMBER", "Flow"), output("pressure", "NUMBER", "Discharge pressure")],
  FAN: GENERIC_LOAD,
  CONVEYOR: GENERIC_LOAD,
  MIXER: GENERIC_LOAD,
  COMPRESSOR: GENERIC_LOAD,
  VALVE: [
    input("open", "BOOL", "Open command"),
    input("close", "BOOL", "Close command"),
    input("positionSetpoint", "NUMBER", "Position setpoint", "%"),
    FAULT_RESET,
    output("position", "NUMBER", "Actual position", "%"),
    output("opened", "BOOL", "Open limit switch"),
    output("closed", "BOOL", "Closed limit switch"),
    FAULTED,
  ],
  SENSOR: [output("value", "NUMBER", "Measured value"), FAULTED],
  SWITCH: [output("state", "BOOL", "Switch state")],
};

export function findSignal(type: SimulatedType, key: string): SignalDefinition | undefined {
  return DEVICE_SIGNALS[type].find((signal) => signal.key === key);
}

/**
 * Which way a device signal flows, from its key alone: a key means the same in every type
 * (`run` is always a command, `running` always feedback). Undefined for an unknown key.
 */
export function deviceSignalDirection(key: string): SignalDirection | undefined {
  for (const signals of Object.values(DEVICE_SIGNALS)) {
    const signal = signals.find((candidate) => candidate.key === key);
    if (signal) return signal.direction;
  }
  return undefined;
}

export type FaultDefinition = {
  code: string;
  name: string;
  severity: Severity;
  /** A latching fault trips the device: it stays faulted after the cause is cleared, until reset. */
  latching: boolean;
  /** The device does not report it on its own fault output; PLC logic has to detect it. */
  silent?: boolean;
};

const STUCK: FaultDefinition = { code: "STUCK", name: "Stuck", severity: "WARNING", latching: false, silent: true };

/**
 * The generic faults of the fault standard (TASK-1014). OFFLINE belongs to every device:
 * lost supply, disconnected, powered down; the behaviour is not stepped, its feedback reads
 * de-energized, its quality is BAD, and when the fault ends the behaviour restarts from
 * its initial state, as equipment does after a power cycle. Silent: an unpowered device
 * reports nothing. COMM_LOSS belongs to every device served over a protocol: the runtime
 * stops answering for it and its quality is BAD.
 */
export const OFFLINE: FaultDefinition = {
  code: "OFFLINE",
  name: "Device unavailable",
  severity: "CRITICAL",
  latching: false,
  silent: true,
};
export const COMM_LOSS: FaultDefinition = {
  code: "COMM_LOSS",
  name: "Communication lost",
  severity: "CRITICAL",
  latching: false,
  silent: true,
};
/** Fault codes every device may have without the profile or a vendor document naming them. */
export const GENERIC_FAULT_CODES: ReadonlySet<string> = new Set([OFFLINE.code, COMM_LOSS.code]);

/** A limit-switch disagreement: both end switches read at once, whatever the position (TASK-1014). */
const LIMIT_SWITCH_FAULT: FaultDefinition = {
  code: "LIMIT_SWITCH_FAULT",
  name: "Limit switch disagreement",
  severity: "WARNING",
  latching: false,
  silent: true,
};

export const DEVICE_FAULTS: Record<SimulatedType, readonly FaultDefinition[]> = {
  VFD: [
    { code: "OVERCURRENT", name: "Overcurrent trip", severity: "CRITICAL", latching: true },
    { code: "OVERTEMPERATURE", name: "Overtemperature trip", severity: "CRITICAL", latching: true },
    OFFLINE,
  ],
  MOTOR: [{ code: "OVERLOAD", name: "Overload trip", severity: "CRITICAL", latching: true }, OFFLINE],
  PUMP: [{ code: "DRY_RUN", name: "Dry running", severity: "WARNING", latching: false }, OFFLINE],
  FAN: [OFFLINE],
  CONVEYOR: [OFFLINE],
  MIXER: [OFFLINE],
  COMPRESSOR: [OFFLINE],
  VALVE: [STUCK, LIMIT_SWITCH_FAULT, OFFLINE],
  SENSOR: [{ code: "BAD_QUALITY", name: "Signal lost", severity: "WARNING", latching: false }, STUCK, OFFLINE],
  SWITCH: [STUCK, OFFLINE],
};

/** Event types the simulator emits (docs/events-telemetry.md). */
export const SIMULATION_EVENT_TYPES = [
  "SIMULATION_STARTED",
  "SIMULATION_STOPPED",
  "VFD_STATE_CHANGED",
  "MOTOR_STATE_CHANGED",
  "PUMP_STATE_CHANGED",
  "VALVE_STATE_CHANGED",
  "SENSOR_VALUE_CHANGED",
  "DEVICE_STATE_CHANGED",
  "FAULT_INJECTED",
  "FAULT_CLEARED",
  "DEVICE_RESET",
  "QUALITY_CHANGED",
  "SIMULATED_INPUT_FORCED",
  "SIMULATED_INPUT_RELEASED",
  "CONNECTION_UP",
  "CONNECTION_DOWN",
] as const;
export type SimulationEventType = (typeof SIMULATION_EVENT_TYPES)[number];
