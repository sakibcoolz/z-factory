/**
 * The behaviour contract of the simulated device categories (TASK-1010, ADR-0026):
 * what every behaviour profile declares about itself, machine-readable, in one place.
 *
 * A profile is the documented generic behaviour of one device category: its commands and
 * feedback, its parameters with units and bounds, its states, its faults with their reset
 * rule and their effect on quality, the devices it is coupled to, what it speaks, whether
 * a tester may force it, and how faithful it is. The catalog (`lib/catalog/schema.ts`)
 * checks every model's simulation metadata against this contract; the Go runtime
 * (`services/process-sim/internal/device`) describes the same facts over `GET /v1/profiles`,
 * and the parity test keeps the two together.
 *
 * Nothing here is a vendor specification. Every default is a generic value for a generic
 * device, and a profile makes no claim about any manufacturer's product or firmware.
 * Pure data; importable anywhere.
 */
import {
  COMM_LOSS,
  DEVICE_FAULTS,
  DEVICE_SIGNALS,
  type FaultDefinition,
  LOAD_TYPES,
  OFFLINE,
  type SignalDefinition,
  type SimulatedType,
} from "@/lib/domain/simulation";

/** The version of the behaviour contract: the shape of a profile description. */
export const BEHAVIOR_CONTRACT_VERSION = 1;

/**
 * How much of a catalog model's behaviour the simulator implements (Phase 10). Mirrors
 * the database enum `SimulationCoverage`. Every catalog model declares exactly one.
 */
export const SIMULATION_COVERAGES = ["FULL", "PARTIAL", "GENERIC", "NOT_SIMULATABLE"] as const;
export type SimulationCoverage = (typeof SIMULATION_COVERAGES)[number];

export const SIMULATION_COVERAGE_LABELS: Record<SimulationCoverage, string> = {
  FULL: "full",
  PARTIAL: "partial",
  GENERIC: "generic",
  NOT_SIMULATABLE: "not simulated",
};

/**
 * What the coverage of a model means, in words a screen or an agent can show. A behaviour
 * model is never vendor firmware, whatever its coverage; the sentence says so.
 */
export function coverageStatement(coverage: SimulationCoverage, profile: { key: string; version: number } | null) {
  const named = profile ? ` (behaviour profile ${profile.key} v${profile.version})` : "";
  switch (coverage) {
    case "FULL":
      return `every declared behaviour of this model is implemented${named}: a behaviour model, not vendor firmware`;
    case "PARTIAL":
      return `a declared subset of this model's behaviour is implemented${named}: a behaviour model, not vendor firmware`;
    case "GENERIC":
      return `the generic behaviour of its category${named}: a behaviour model, not vendor firmware`;
    case "NOT_SIMULATABLE":
      return "configuration and metadata only; the simulator executes no behaviour for it";
  }
}

/**
 * A command or a piece of feedback. IN: PLC logic drives it (a command or a setpoint);
 * OUT: the device produces it for the PLC (actual value or status). A numeric signal may
 * declare its range, by numbers or by the parameter that sets a bound.
 */
export type BehaviorSignal = SignalDefinition & {
  range?: { min?: number; max?: number; minParameter?: string; maxParameter?: string };
};

/** What a parameter is for, so timing, ratings and limits can be told apart by a machine. */
export const PARAMETER_ROLES = ["RATING", "TIMING", "LIMIT", "INITIAL", "SOURCE", "SHAPE", "EVENT"] as const;
export type ParameterRole = (typeof PARAMETER_ROLES)[number];

export type NumberParameter = {
  kind: "NUMBER";
  key: string;
  label: string;
  role: ParameterRole;
  unit: string | null;
  /** The generic default; null for an optional parameter the behaviour derives when absent. */
  default: number | null;
  min: number | null;
  max: number | null;
  minInclusive: boolean;
  maxInclusive: boolean;
  description: string | null;
};

export type ChoiceParameter = {
  kind: "CHOICE";
  key: string;
  label: string;
  role: ParameterRole;
  default: string;
  choices: readonly string[];
  description: string | null;
};

/** A structured parameter such as a signal source: one of several kinds, each with its own fields. */
export type StructuredParameter = {
  kind: "STRUCTURED";
  key: string;
  label: string;
  role: ParameterRole;
  default: Readonly<Record<string, unknown>>;
  /** The kinds the structure may take, each with its fields. */
  kinds: Readonly<Record<string, readonly string[]>>;
  description: string | null;
};

export type BehaviorParameter = NumberParameter | ChoiceParameter | StructuredParameter;

/** How a fault ends: on its own when the cause is gone, or only by a reset. */
export type FaultReset = "AUTO" | "RESET_SIGNAL_OR_OPERATOR";

export type BehaviorFault = FaultDefinition & {
  reset: FaultReset;
  /** What the fault does to the device while it is present. */
  effect: string;
  /** The quality of the device's feedback while the fault is present. */
  quality: "GOOD" | "BAD";
};

/** A coupling to another device of the factory, by role, and the relationship it is made from. */
export type BehaviorLink = {
  role: string;
  /** The device cannot do its job without it. */
  required: boolean;
  /** Profiles the linked device may have; null accepts any device that produces the needed signal. */
  accepts: readonly string[] | null;
  relationship: "DRIVES" | "MECHANICALLY_DRIVES" | "MEASURES" | "CONTROLS";
  /** Whether the linked device is the source or the target of that relationship. */
  peerIs: "SOURCE" | "TARGET";
  meaning: string;
};

/** What the device speaks: nothing (hardwired), or a protocol the runtime serves (TASK-1013). */
export type BehaviorProtocol = "NONE" | "MODBUS_TCP";

export type BehaviorProfile = {
  key: string;
  version: number;
  /** The catalog simulator type (`SimulatorType`) the profile implements. */
  simulatorType: string;
  /**
   * Where the profile runs today: the Go runtime (every profile) and, for the ten ported
   * from it, the server's own simulator. A catalog model is executed only on a profile
   * the server runs until TASK-1015 moves factories to the runtime.
   */
  runsOn: { server: boolean; runtime: true };
  /** What the profile models, in one sentence, and what it does not. */
  summary: string;
  signals: readonly BehaviorSignal[];
  parameters: readonly BehaviorParameter[];
  states: readonly string[];
  faults: readonly BehaviorFault[];
  /** Faults that make the feedback BAD while present; the runtime setting a device aside always does. */
  badQualityOnFaults: readonly string[];
  links: readonly BehaviorLink[];
  protocol: BehaviorProtocol;
  forcible: boolean;
  forcedKind?: "BOOL" | "NUMBER";
  fidelity: {
    /** How the physics is approximated. */
    approximations: readonly string[];
    /** What is deliberately not modelled. */
    notModelled: readonly string[];
  };
};

const number = (
  key: string,
  label: string,
  role: ParameterRole,
  defaultValue: number | null,
  bounds: Partial<Pick<NumberParameter, "unit" | "min" | "max" | "minInclusive" | "maxInclusive" | "description">> = {},
): NumberParameter => ({
  kind: "NUMBER",
  key,
  label,
  role,
  unit: bounds.unit ?? null,
  default: defaultValue,
  min: bounds.min ?? null,
  max: bounds.max ?? null,
  minInclusive: bounds.minInclusive ?? false,
  maxInclusive: bounds.maxInclusive ?? false,
  description: bounds.description ?? null,
});

/** A positive rating, with no upper bound. */
const rating = (key: string, label: string, defaultValue: number, unit: string | null, description?: string) =>
  number(key, label, "RATING", defaultValue, { unit, min: 0, description });

/** A duration in seconds: above zero, at most an hour. */
const seconds = (key: string, label: string, defaultValue: number, description?: string) =>
  number(key, label, "TIMING", defaultValue, { unit: "s", min: 0, max: 3600, maxInclusive: true, description });

const commands = (signals: readonly SignalDefinition[]) => signals.filter((signal) => signal.direction === "IN");
const feedback = (signals: readonly SignalDefinition[]) => signals.filter((signal) => signal.direction === "OUT");

/** The signals of a simulated type, with their ranges. */
function signalsOf(type: SimulatedType, ranges: Record<string, BehaviorSignal["range"]> = {}): BehaviorSignal[] {
  return DEVICE_SIGNALS[type].map((signal) => {
    const range = ranges[signal.key];
    return range ? { ...signal, range } : { ...signal };
  });
}

/**
 * The generic faults of the fault standard (TASK-1014), with their effect and quality:
 * OFFLINE on every profile, COMM_LOSS on every device served over a protocol.
 */
const GENERIC_FAULT_EFFECTS: Record<string, { effect: string; quality: "BAD" }> = {
  OFFLINE: {
    effect:
      "not stepped; every output reads de-energized (false / 0) and quality is BAD; its physics is wiped at once, so a motor it feeds coasts and a device it switches opens; it restarts from its initial state, untripped, when the fault ends",
    quality: "BAD",
  },
  COMM_LOSS: {
    effect: "the runtime answers nothing for its unit id (exception 0B); the behaviour goes on; quality is BAD",
    quality: "BAD",
  },
};

const generic = (definition: FaultDefinition): BehaviorFault => ({
  ...definition,
  reset: "AUTO",
  effect: GENERIC_FAULT_EFFECTS[definition.code]!.effect,
  quality: GENERIC_FAULT_EFFECTS[definition.code]!.quality,
});

/** The fault every profile has: the device unavailable. */
export const OFFLINE_FAULT: BehaviorFault = generic(OFFLINE);
/** The fault every served device has: its communication lost. */
export const COMM_LOSS_FAULT: BehaviorFault = generic(COMM_LOSS);

/** The faults of a simulated type, with their reset rule, effect and quality. */
function faultsOf(type: SimulatedType, effects: Record<string, { effect: string; quality?: "BAD" }>): BehaviorFault[] {
  return DEVICE_FAULTS[type].map((fault) => {
    const detail = effects[fault.code] ?? GENERIC_FAULT_EFFECTS[fault.code];
    if (!detail) throw new Error(`behaviour contract: ${type} does not describe the effect of ${fault.code}`);
    return {
      ...fault,
      reset: fault.latching ? "RESET_SIGNAL_OR_OPERATOR" : "AUTO",
      effect: detail.effect,
      quality: detail.quality ?? "GOOD",
    };
  });
}

/** The ten profiles ported from the server's simulator run in both engines; the rest in the runtime only. */
const BOTH = { server: true, runtime: true } as const;
const RUNTIME_ONLY = { server: false, runtime: true } as const;

/** The controller whose output a heater or a valve takes (TASK-1011). */
const CONTROLLER_LINK = (meaning: string): BehaviorLink => ({
  role: "controller",
  required: false,
  accepts: ["PID_CONTROLLER"],
  relationship: "CONTROLS",
  peerIs: "SOURCE",
  meaning,
});

const NON_NEGATIVE = { min: 0 } as const;
const PERCENT = { min: 0, max: 100 } as const;

const MOTOR_LINK: BehaviorLink = {
  role: "motor",
  required: true,
  accepts: ["MOTOR"],
  relationship: "MECHANICALLY_DRIVES",
  peerIs: "SOURCE",
  meaning: "the motor on the shaft; one motor drives one load",
};

const measuresLink = (meaning: string): BehaviorLink => ({
  role: "measures",
  required: false,
  accepts: null,
  relationship: "MEASURES",
  peerIs: "TARGET",
  meaning: `${meaning}; required when the source is MEASURED`,
});

const SENSOR_SOURCE_KINDS = {
  CONSTANT: ["value"],
  RAMP: ["from", "to", "periodS"],
  SINE: ["min", "max", "periodS"],
  RANDOM: ["min", "max", "intervalS", "seed"],
  MEASURED: ["signal", "gain", "offset"],
} as const;

const SWITCH_SOURCE_KINDS = { CONSTANT: ["state"], MEASURED: ["signal", "onAbove", "offBelow"] } as const;

const VFD: BehaviorProfile = {
  key: "VFD",
  version: 1,
  simulatorType: "VFD",
  runsOn: BOTH,
  summary:
    "A drive with hardwired control: ramps its output frequency to the setpoint while the run command is on, through zero on a reversal; a trip removes the output at once.",
  signals: signalsOf("VFD", {
    frequencySetpoint: { min: 0, maxParameter: "maxFrequencyHz" },
    actualFrequency: { min: 0, maxParameter: "maxFrequencyHz" },
    outputCurrent: NON_NEGATIVE,
  }),
  parameters: [
    number("maxFrequencyHz", "Maximum output frequency", "RATING", 50, {
      unit: "Hz",
      min: 0,
      max: 1000,
      maxInclusive: true,
    }),
    seconds("accelTimeS", "Acceleration time", 5, "Time to ramp from zero to the maximum frequency."),
    seconds("decelTimeS", "Deceleration time", 5, "Time to ramp from the maximum frequency to zero."),
  ],
  states: ["STOPPED", "ACCELERATING", "RUNNING", "DECELERATING", "FAULTED"],
  faults: faultsOf("VFD", {
    OVERCURRENT: { effect: "output removed at once; the motor coasts" },
    OVERTEMPERATURE: { effect: "output removed at once; the motor coasts" },
  }),
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: [
      "linear ramp at maxFrequencyHz / accelTimeS (or decelTimeS)",
      "the setpoint is limited to 0…maxFrequencyHz",
      "a change of direction ramps through zero",
      "output current is the current of the motor it drives",
    ],
    notModelled: ["V/f curve", "current limit", "DC bus", "braking"],
  },
};

const MOTOR: BehaviorProfile = {
  key: "MOTOR",
  version: 1,
  simulatorType: "MOTOR",
  runsOn: BOTH,
  summary:
    "An induction motor whose speed follows its supply frequency with a first-order lag and whose current follows the load torque; direct-on-line from a contactor command when it has no drive.",
  signals: signalsOf("MOTOR", { actualSpeed: NON_NEGATIVE, current: NON_NEGATIVE }),
  parameters: [
    rating("ratedSpeedRpm", "Rated speed", 1450, "rpm"),
    rating("ratedFrequencyHz", "Rated frequency", 50, "Hz"),
    rating("ratedCurrentA", "Rated current", 10, "A"),
    number("noLoadCurrentRatio", "No-load current ratio", "RATING", 0.35, {
      min: 0,
      max: 1,
      minInclusive: true,
      maxInclusive: true,
      description: "Share of the rated current drawn with no load on the shaft.",
    }),
    seconds("timeConstantS", "Speed time constant", 0.5, "First-order response of the speed to a change of supply."),
    seconds("coastTimeConstantS", "Coast-down time constant", 2, "First-order coast-down once the supply is gone."),
  ],
  states: ["STOPPED", "RUNNING", "COASTING", "FAULTED"],
  faults: faultsOf("MOTOR", { OVERLOAD: { effect: "motor de-energized even while its drive runs" } }),
  badQualityOnFaults: [],
  links: [
    {
      role: "drive",
      required: false,
      accepts: ["VFD", "RELAY", "SOFT_STARTER", "MOTOR_STARTER"],
      relationship: "DRIVES",
      peerIs: "SOURCE",
      meaning:
        "the drive, relay, contactor or starter that supplies the motor; one supplies one motor; without one, the run command is a contactor",
    },
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: [
      "speed = rated speed × supply frequency / rated frequency, reached with a first-order lag",
      "current = rated × (no-load share + remaining share × load torque)",
    ],
    notModelled: ["slip", "inrush current", "thermal behaviour"],
  },
};

const PUMP: BehaviorProfile = {
  key: "PUMP",
  version: 1,
  simulatorType: "PUMP",
  runsOn: BOTH,
  summary:
    "A centrifugal pump on a motor: flow proportional to speed, pressure to speed squared; dry running removes both and unloads the motor.",
  signals: signalsOf("PUMP", { flow: NON_NEGATIVE, pressure: NON_NEGATIVE }),
  parameters: [
    rating("ratedFlow", "Rated flow", 100, null, "Flow at rated speed, in the unit of the tag it is mapped to."),
    rating("ratedPressure", "Rated discharge pressure", 4, null),
  ],
  states: ["STOPPED", "RUNNING", "DRY_RUN"],
  faults: faultsOf("PUMP", { DRY_RUN: { effect: "no flow or pressure; motor load drops" } }),
  badQualityOnFaults: [],
  links: [MOTOR_LINK],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["affinity laws against a fixed system: flow ∝ speed, pressure ∝ speed²"],
    notModelled: ["pump curve", "interaction with valves or tanks (that is process simulation)"],
  },
};

const load = (type: (typeof LOAD_TYPES)[number], shape: "QUADRATIC" | "CONSTANT"): BehaviorProfile => ({
  key: type,
  version: 1,
  simulatorType: type,
  runsOn: BOTH,
  summary: `Motor-driven equipment whose output follows the speed of its motor; shaft torque ${
    shape === "QUADRATIC" ? "grows with the square of the speed" : "is constant once it moves"
  } unless the parameters say otherwise.`,
  signals: signalsOf(type, { output: NON_NEGATIVE }),
  parameters: [
    rating("ratedOutput", "Rated output", 100, null, "Output at rated speed: airflow, belt speed, …"),
    {
      kind: "CHOICE",
      key: "loadProfile",
      label: "Load profile",
      role: "SHAPE",
      default: shape,
      choices: ["QUADRATIC", "CONSTANT"],
      description: "How shaft torque grows with speed.",
    },
  ],
  states: ["STOPPED", "RUNNING"],
  faults: [],
  badQualityOnFaults: [],
  links: [MOTOR_LINK],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["output ∝ speed", `torque ${shape === "QUADRATIC" ? "quadratic" : "constant"} by default`],
    notModelled: ["the process the equipment acts on"],
  },
});

const VALVE: BehaviorProfile = {
  key: "VALVE",
  version: 1,
  simulatorType: "VALVE",
  runsOn: BOTH,
  summary:
    "A valve that travels at its stroke time to the commanded position (open/close commands, or an analog setpoint) and reports its position and limit switches; stuck, it stays where it is.",
  signals: signalsOf("VALVE", { positionSetpoint: PERCENT, position: PERCENT }),
  parameters: [
    seconds("travelTimeS", "Travel time", 5, "Time for a full stroke."),
    number("initialPosition", "Initial position", "INITIAL", 0, {
      unit: "%",
      min: 0,
      max: 100,
      minInclusive: true,
      maxInclusive: true,
    }),
  ],
  states: ["CLOSED", "OPENING", "OPEN", "CLOSING", "STOPPED", "FAULTED"],
  faults: faultsOf("VALVE", {
    STUCK: { effect: "does not move; not reported on faulted" },
    LIMIT_SWITCH_FAULT: { effect: "both limit switches read closed whatever the position; not reported on faulted" },
  }),
  badQualityOnFaults: [],
  links: [
    CONTROLLER_LINK(
      "the controller whose output is the position setpoint while it is enabled; the PLC's commands apply otherwise",
    ),
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: [
      "constant travel speed",
      "with only open wired it returns to closed when the command drops; with close also wired it holds position when neither is present; positionSetpoint takes precedence",
    ],
    notModelled: ["flow through the valve", "actuator supply"],
  },
};

const SENSOR: BehaviorProfile = {
  key: "SENSOR",
  version: 1,
  simulatorType: "SENSOR",
  runsOn: BOTH,
  summary:
    "A transmitter that reports a value from a constant, ramp, sine, seeded-random or measured source through a first-order lag within its range; signal loss reads bottom of range with bad quality.",
  signals: signalsOf("SENSOR", { value: { minParameter: "rangeMin", maxParameter: "rangeMax" } }),
  parameters: [
    {
      kind: "STRUCTURED",
      key: "source",
      label: "Signal source",
      role: "SOURCE",
      default: { kind: "CONSTANT", value: 0 },
      kinds: SENSOR_SOURCE_KINDS,
      description: "Where the value comes from; a MEASURED source follows an output signal of the measured device.",
    },
    number("rangeMin", "Range minimum", "LIMIT", null, { description: "Below rangeMax; the value saturates at it." }),
    number("rangeMax", "Range maximum", "LIMIT", null),
    number("timeConstantS", "Response time constant", "TIMING", 0, {
      unit: "s",
      min: 0,
      max: 3600,
      minInclusive: true,
      maxInclusive: true,
      description: "First-order response of the sensor; 0 follows the source immediately.",
    }),
    number("initialValue", "Initial value", "INITIAL", null),
    number("eventDeadband", "Event deadband", "EVENT", null, {
      min: 0,
      description: "A SENSOR_VALUE_CHANGED event is emitted when the value moves by at least this much.",
    }),
  ],
  states: ["GOOD", "BAD"],
  faults: faultsOf("SENSOR", {
    BAD_QUALITY: { effect: "reads bottom of range, faulted true, quality BAD", quality: "BAD" },
    STUCK: { effect: "value frozen; not reported" },
  }),
  badQualityOnFaults: ["BAD_QUALITY"],
  links: [measuresLink("the device whose output signal a MEASURED source follows")],
  protocol: "NONE",
  forcible: true,
  forcedKind: "NUMBER",
  fidelity: {
    approximations: ["ideal source, optional first-order lag, limited to its range"],
    notModelled: [
      "noise or drift unless a RANDOM source is configured",
      "calibration",
      "wiring faults other than signal loss",
    ],
  },
};

const SWITCH: BehaviorProfile = {
  key: "SWITCH",
  version: 1,
  simulatorType: "SWITCH",
  runsOn: BOTH,
  summary:
    "A contact held at a constant state, operated by hand, or switching on a measured signal with hysteresis; stuck, it keeps its state.",
  signals: signalsOf("SWITCH"),
  parameters: [
    {
      kind: "STRUCTURED",
      key: "source",
      label: "Signal source",
      role: "SOURCE",
      default: { kind: "CONSTANT", state: false },
      kinds: SWITCH_SOURCE_KINDS,
      description:
        "A constant state, or a MEASURED source that closes at or above onAbove and opens at or below offBelow.",
    },
  ],
  states: ["OFF", "ON"],
  faults: faultsOf("SWITCH", { STUCK: { effect: "state frozen; not reported" } }),
  badQualityOnFaults: [],
  links: [measuresLink("the device whose numeric output signal a MEASURED source switches on")],
  protocol: "NONE",
  forcible: true,
  forcedKind: "BOOL",
  fidelity: {
    approximations: ["ideal contact; hysteresis from onAbove and offBelow"],
    notModelled: ["contact bounce", "wear"],
  },
};

// ----- The behaviour library (TASK-1011): runtime-only profiles -------------------------

const signal = (
  key: string,
  direction: "IN" | "OUT",
  kind: "BOOL" | "NUMBER",
  label: string,
  unit?: string,
  range?: BehaviorSignal["range"],
): BehaviorSignal => ({ key, direction, kind, label, ...(unit ? { unit } : {}), ...(range ? { range } : {}) });

const FAULT_RESET = signal("faultReset", "IN", "BOOL", "Fault reset (rising edge)");
const FAULTED = signal("faulted", "OUT", "BOOL", "Fault active");

const fault = (
  code: string,
  name: string,
  severity: BehaviorFault["severity"],
  options: { latching?: boolean; silent?: boolean; quality?: "BAD"; effect: string },
): BehaviorFault => ({
  code,
  name,
  severity,
  latching: options.latching ?? false,
  ...(options.silent ? { silent: true } : {}),
  reset: options.latching ? "RESET_SIGNAL_OR_OPERATOR" : "AUTO",
  effect: options.effect,
  quality: options.quality ?? "GOOD",
});

const RELAY: BehaviorProfile = {
  key: "RELAY",
  version: 1,
  simulatorType: "RELAY",
  runsOn: RUNTIME_ONLY,
  summary:
    "A relay, contactor or solid-state relay: its contacts close a pickup time after the coil is energized and open a dropout time after it is released; auxiliary contacts follow; welded contacts stay closed and an open coil never closes them.",
  signals: [
    signal("coil", "IN", "BOOL", "Coil (control input)"),
    signal("closed", "OUT", "BOOL", "Main contacts closed"),
    signal("auxNo", "OUT", "BOOL", "Auxiliary contact, normally open"),
    signal("auxNc", "OUT", "BOOL", "Auxiliary contact, normally closed"),
  ],
  parameters: [
    {
      kind: "CHOICE",
      key: "kind",
      label: "Kind",
      role: "SHAPE",
      default: "ELECTROMECHANICAL",
      choices: ["ELECTROMECHANICAL", "SOLID_STATE"],
      description: "A solid-state relay switches without pickup or dropout delay.",
    },
    number("pickupTimeS", "Pickup time", "TIMING", 0.02, {
      unit: "s",
      min: 0,
      max: 10,
      minInclusive: true,
      maxInclusive: true,
      description: "Time from coil on to contacts closed.",
    }),
    number("dropoutTimeS", "Dropout time", "TIMING", 0.02, {
      unit: "s",
      min: 0,
      max: 10,
      minInclusive: true,
      maxInclusive: true,
      description: "Time from coil off to contacts open.",
    }),
  ],
  states: ["OPEN", "PICKING_UP", "CLOSED", "DROPPING_OUT"],
  faults: [
    fault("WELDED_CONTACTS", "Welded contacts", "CRITICAL", {
      silent: true,
      effect: "contacts stay closed whatever the coil does; not reported",
    }),
    fault("COIL_OPEN", "Coil open circuit", "WARNING", { silent: true, effect: "contacts never close; not reported" }),
  ],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["one pickup and one dropout delay", "auxiliary contacts follow the main contacts exactly"],
    notModelled: ["contact bounce", "arcing and wear", "coil inrush", "contact resistance"],
  },
};

const HEATER: BehaviorProfile = {
  key: "HEATER",
  version: 1,
  simulatorType: "HEATER",
  runsOn: RUNTIME_ONLY,
  summary:
    "A heating element with a thermal mass: energized through its contactor or the on command, at the commanded power share, it warms with a first-order lag towards ambient plus its rise at that power, cools the same way when off, and cuts out above its maximum temperature.",
  signals: [
    signal("on", "IN", "BOOL", "On command (heaters without a contactor)"),
    signal("power", "IN", "NUMBER", "Power share", "%", PERCENT),
    FAULT_RESET,
    signal("heating", "OUT", "BOOL", "Heating"),
    signal("temperature", "OUT", "NUMBER", "Element temperature", "°C"),
    signal("powerOutput", "OUT", "NUMBER", "Power delivered", "kW", { min: 0, maxParameter: "ratedPowerKw" }),
    signal("cutout", "OUT", "BOOL", "Thermostat cutout"),
    FAULTED,
  ],
  parameters: [
    rating("ratedPowerKw", "Rated power", 5, "kW"),
    number("ambientC", "Ambient temperature", "RATING", 20, {
      unit: "°C",
      min: -100,
      max: 500,
      minInclusive: true,
      maxInclusive: true,
      description: "Temperature the element rests at when off.",
    }),
    number("riseAtFullPowerC", "Rise at full power", "RATING", 100, {
      unit: "K",
      min: 0,
      max: 2000,
      maxInclusive: true,
      description: "Steady-state rise above ambient at full power.",
    }),
    seconds("timeConstantS", "Thermal time constant", 300, "First-order time constant of heating and cooling."),
    number("maxTemperatureC", "Cutout temperature", "LIMIT", 250, {
      unit: "°C",
      min: -100,
      max: 2000,
      minInclusive: true,
      maxInclusive: true,
      description: "The thermostat removes power above it.",
    }),
    number("cutoutHysteresisC", "Cutout hysteresis", "LIMIT", 10, {
      unit: "K",
      min: 0,
      max: 100,
      maxInclusive: true,
      description: "Power returns once the element has cooled by this much.",
    }),
    number("initialTemperatureC", "Initial temperature", "INITIAL", null, {
      unit: "°C",
      description: "Ambient when absent.",
    }),
  ],
  states: ["OFF", "HEATING", "CUTOUT", "FAULTED"],
  faults: [
    fault("OVERTEMPERATURE", "Overtemperature trip", "CRITICAL", {
      latching: true,
      effect: "power removed at once; the element cools",
    }),
    fault("ELEMENT_FAILURE", "Element failure", "WARNING", {
      silent: true,
      effect: "no power delivered while energized; not reported",
    }),
  ],
  badQualityOnFaults: [],
  links: [
    {
      role: "contactor",
      required: false,
      accepts: ["RELAY"],
      relationship: "CONTROLS",
      peerIs: "SOURCE",
      meaning: "the relay or contactor that switches the element; without one, the on command energizes it",
    },
    CONTROLLER_LINK(
      "the controller whose output is the power share; the element is energized while it is enabled, and the PLC's on and power are ignored",
    ),
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: [
      "one lumped thermal mass with one time constant",
      "steady-state rise proportional to the power share",
      "a thermostat cutout with hysteresis",
    ],
    notModelled: ["element resistance and supply voltage", "radiation and air flow", "the process being heated"],
  },
};

const INDICATOR: BehaviorProfile = {
  key: "INDICATOR",
  version: 1,
  simulatorType: "INDICATOR",
  runsOn: RUNTIME_ONLY,
  summary:
    "A stack light, lamp or buzzer: each lamp and the buzzer follow their command, the commanded lamps flash at the flash rate while the flash command is on, and a failed lamp set lights nothing.",
  signals: [
    signal("red", "IN", "BOOL", "Red lamp command"),
    signal("amber", "IN", "BOOL", "Amber lamp command"),
    signal("green", "IN", "BOOL", "Green lamp command"),
    signal("blue", "IN", "BOOL", "Blue lamp command"),
    signal("buzzer", "IN", "BOOL", "Buzzer command"),
    signal("flash", "IN", "BOOL", "Flash the commanded lamps"),
    signal("redLit", "OUT", "BOOL", "Red lamp lit"),
    signal("amberLit", "OUT", "BOOL", "Amber lamp lit"),
    signal("greenLit", "OUT", "BOOL", "Green lamp lit"),
    signal("blueLit", "OUT", "BOOL", "Blue lamp lit"),
    signal("buzzerOn", "OUT", "BOOL", "Buzzer sounding"),
  ],
  parameters: [
    number("flashRateHz", "Flash rate", "TIMING", 1, {
      unit: "Hz",
      min: 0,
      max: 10,
      maxInclusive: true,
      description: "Flashes per second while the flash command is on.",
    }),
  ],
  states: ["OFF", "ON", "FLASHING"],
  faults: [fault("LAMP_FAILURE", "Lamp failure", "WARNING", { silent: true, effect: "no lamp lights; not reported" })],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["lamps are on or off, lit for the first half of every flash period", "one buzzer tone"],
    notModelled: ["brightness", "lamp test input", "sound level"],
  },
};

// ----- Starters and servo (TASK-1011 PR B) -----------------------------------------------

const RUNNING = signal("running", "OUT", "BOOL", "Running");

const SOFT_STARTER: BehaviorProfile = {
  key: "SOFT_STARTER",
  version: 1,
  simulatorType: "SOFT_STARTER",
  runsOn: RUNTIME_ONLY,
  summary:
    "A reduced-voltage starter: ramps its output voltage from the initial voltage to full over the ramp time and closes its bypass, ramps down on stop, and limits the motor's speed to the voltage share while it ramps; a trip removes the output at once.",
  signals: [
    signal("run", "IN", "BOOL", "Run command"),
    FAULT_RESET,
    RUNNING,
    signal("bypassed", "OUT", "BOOL", "Bypass closed (full voltage)"),
    FAULTED,
    signal("outputVoltage", "OUT", "NUMBER", "Output voltage", "%", PERCENT),
    signal("outputCurrent", "OUT", "NUMBER", "Output current", "A", NON_NEGATIVE),
  ],
  parameters: [
    number("initialVoltagePct", "Initial voltage", "RATING", 30, {
      unit: "%",
      min: 0,
      max: 100,
      minInclusive: true,
      maxInclusive: true,
      description: "Output voltage at the start of the ramp.",
    }),
    seconds("rampTimeS", "Ramp time", 5, "Time from the initial voltage to full voltage."),
    number("rampDownTimeS", "Ramp-down time", "TIMING", 0, {
      unit: "s",
      min: 0,
      max: 3600,
      minInclusive: true,
      maxInclusive: true,
      description: "Time from full voltage to zero on stop; zero stops at once.",
    }),
  ],
  states: ["STOPPED", "RAMPING_UP", "BYPASSED", "RAMPING_DOWN", "FAULTED"],
  faults: [
    fault("OVERCURRENT", "Overcurrent trip", "CRITICAL", {
      latching: true,
      effect: "output removed at once; the motor coasts",
    }),
    fault("OVERTEMPERATURE", "Overtemperature trip", "CRITICAL", {
      latching: true,
      effect: "output removed at once; the motor coasts",
    }),
  ],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["a linear voltage ramp", "the motor's speed limited to the voltage share while ramping"],
    notModelled: ["torque curve", "current limit", "kick start", "braking"],
  },
};

const MOTOR_STARTER: BehaviorProfile = {
  key: "MOTOR_STARTER",
  version: 1,
  simulatorType: "MOTOR_STARTER",
  runsOn: RUNTIME_ONLY,
  summary:
    "A direct-on-line starter with an overload relay: the run command closes its contactor and the motor runs at line frequency; the relay's thermal image grows while the motor's current exceeds the setting, trips the starter when it reaches its limit, and cools below the setting.",
  signals: [
    signal("run", "IN", "BOOL", "Run command"),
    FAULT_RESET,
    RUNNING,
    FAULTED,
    signal("current", "OUT", "NUMBER", "Motor current", "A", NON_NEGATIVE),
    signal("thermalLoad", "OUT", "NUMBER", "Overload relay thermal load", "%", PERCENT),
  ],
  parameters: [
    rating("overloadSettingA", "Overload setting", 10, "A", "Current setting of the overload relay."),
    number("tripClass", "Trip class", "TIMING", 10, {
      unit: "s",
      min: 0,
      max: 60,
      maxInclusive: true,
      description: "Seconds to trip from cold at 7.2 times the setting (class 10, 20, 30).",
    }),
    seconds(
      "coolingTimeS",
      "Cooling time constant",
      120,
      "Time constant of the thermal image cooling below the setting.",
    ),
  ],
  states: ["STOPPED", "RUNNING", "FAULTED"],
  faults: [
    fault("OVERLOAD", "Overload trip", "CRITICAL", {
      latching: true,
      effect: "contactor opened; raised by the relay's own thermal image or injected",
    }),
  ],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["a single thermal image whose time to trip follows the trip class at 7.2 times the setting"],
    notModelled: ["phase loss", "earth fault", "contactor delay"],
  },
};

const SERVO_DRIVE: BehaviorProfile = {
  key: "SERVO_DRIVE",
  version: 1,
  simulatorType: "SERVO_DRIVE",
  runsOn: RUNTIME_ONLY,
  summary:
    "A servo drive: enabled, it moves its motor to the position setpoint with a trapezoidal profile under its velocity, acceleration and deceleration limits and reports position, velocity and in-position; disabled, the shaft holds; a trip disables it at once.",
  signals: [
    signal("enable", "IN", "BOOL", "Enable"),
    signal("positionSetpoint", "IN", "NUMBER", "Position setpoint", "units"),
    FAULT_RESET,
    signal("enabled", "OUT", "BOOL", "Enabled"),
    signal("inPosition", "OUT", "BOOL", "In position"),
    signal("moving", "OUT", "BOOL", "Moving"),
    FAULTED,
    signal("actualPosition", "OUT", "NUMBER", "Actual position", "units"),
    signal("actualVelocity", "OUT", "NUMBER", "Actual velocity", "units/s"),
  ],
  parameters: [
    rating("maxVelocity", "Maximum velocity", 1000, "units/s"),
    rating("acceleration", "Acceleration", 5000, "units/s²"),
    rating("deceleration", "Deceleration", 5000, "units/s²"),
    rating(
      "inPositionWindow",
      "In-position window",
      1,
      "units",
      "Distance from the setpoint within which the drive reports in position.",
    ),
    number("initialPosition", "Initial position", "INITIAL", 0, { unit: "units" }),
  ],
  states: ["DISABLED", "HOLDING", "MOVING", "FAULTED"],
  faults: [
    fault("FOLLOWING_ERROR", "Following error", "CRITICAL", {
      latching: true,
      effect: "disabled at once; the shaft holds",
    }),
    fault("OVERCURRENT", "Overcurrent trip", "CRITICAL", {
      latching: true,
      effect: "disabled at once; the shaft holds",
    }),
  ],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["an ideal trapezoidal profile with no following error of its own", "generic position units"],
    notModelled: ["current loop", "torque limit", "homing", "load inertia"],
  },
};

const SERVO_MOTOR: BehaviorProfile = {
  key: "SERVO_MOTOR",
  version: 1,
  simulatorType: "SERVO_MOTOR",
  runsOn: RUNTIME_ONLY,
  summary:
    "A servo motor: its shaft follows its servo drive's profile and its current is a holding share plus a share proportional to the velocity; without a drive it stands still.",
  signals: [
    FAULT_RESET,
    RUNNING,
    FAULTED,
    signal("actualPosition", "OUT", "NUMBER", "Shaft position", "units"),
    signal("actualVelocity", "OUT", "NUMBER", "Shaft velocity", "units/s"),
    signal("current", "OUT", "NUMBER", "Current", "A", NON_NEGATIVE),
  ],
  parameters: [
    rating("ratedCurrentA", "Rated current", 5, "A"),
    number("holdingCurrentRatio", "Holding current ratio", "RATING", 0.1, {
      min: 0,
      max: 1,
      minInclusive: true,
      maxInclusive: true,
      description: "Share of the rated current drawn while holding position.",
    }),
    rating("ratedVelocity", "Rated velocity", 1000, "units/s", "Velocity at which the current reaches the rating."),
  ],
  states: ["STOPPED", "HOLDING", "MOVING", "FAULTED"],
  faults: [
    fault("OVERTEMPERATURE", "Overtemperature trip", "CRITICAL", {
      latching: true,
      effect: "de-energized; the shaft stops",
    }),
  ],
  badQualityOnFaults: [],
  links: [
    {
      role: "drive",
      required: true,
      accepts: ["SERVO_DRIVE"],
      relationship: "DRIVES",
      peerIs: "SOURCE",
      meaning: "the servo drive that positions the motor; one drive positions one motor",
    },
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["the shaft follows the drive exactly", "current from a holding share and the velocity"],
    notModelled: ["inertia", "torque", "a thermal model beyond the injected trip"],
  },
};

const ENCODER: BehaviorProfile = {
  key: "ENCODER",
  version: 1,
  simulatorType: "ENCODER",
  runsOn: RUNTIME_ONLY,
  summary:
    "An encoder on a shaft: counts pulses from a motor's speed or a servo motor's position, accumulating (incremental) or within one revolution (absolute single-turn), and reports the speed; a lost signal freezes the count with bad quality.",
  signals: [
    signal("count", "OUT", "NUMBER", "Pulse count", "pulses"),
    signal("speed", "OUT", "NUMBER", "Shaft speed", "rpm"),
  ],
  parameters: [
    {
      kind: "CHOICE",
      key: "kind",
      label: "Kind",
      role: "SHAPE",
      default: "INCREMENTAL",
      choices: ["INCREMENTAL", "ABSOLUTE"],
      description: "Incremental counts accumulate; absolute reports the position within one revolution.",
    },
    number("pulsesPerRevolution", "Pulses per revolution", "RATING", 1024, {
      unit: "pulses",
      min: 0,
      max: 1000000,
      maxInclusive: true,
    }),
    rating(
      "unitsPerRevolution",
      "Units per revolution",
      1,
      "units",
      "How many position units of a servo motor make one revolution.",
    ),
  ],
  states: ["GOOD", "BAD"],
  faults: [
    fault("SIGNAL_LOSS", "Signal lost", "WARNING", {
      silent: true,
      quality: "BAD",
      effect: "count frozen, speed zero, quality BAD; not reported",
    }),
  ],
  badQualityOnFaults: ["SIGNAL_LOSS"],
  links: [
    {
      role: "measures",
      required: true,
      accepts: ["MOTOR", "SERVO_MOTOR"],
      relationship: "MEASURES",
      peerIs: "TARGET",
      meaning: "the motor or servo motor whose shaft the encoder is on",
    },
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["counts from a motor's speed or a servo motor's position", "an absolute encoder is single-turn"],
    notModelled: ["quadrature", "index pulse", "multi-turn", "resolution loss"],
  },
};

// ----- Controllers and the signal path (TASK-1011 PR B) ----------------------------------

const MEASURED_KINDS = { MEASURED: ["signal", "gain", "offset"] } as const;

const PID_CONTROLLER: BehaviorProfile = {
  key: "PID_CONTROLLER",
  version: 1,
  simulatorType: "PID_CONTROLLER",
  runsOn: RUNTIME_ONLY,
  summary:
    "A PID process or temperature controller: measures its process value from the device it is linked to, follows the PLC's setpoint or its own, and while enabled computes an output share with proportional, integral and derivative action within its output range; in manual it passes the PLC's manual output through; the devices it controls take its output.",
  signals: [
    signal("enable", "IN", "BOOL", "Enable (automatic control)"),
    signal("setpoint", "IN", "NUMBER", "Remote setpoint"),
    signal("manual", "IN", "BOOL", "Manual mode"),
    signal("manualOutput", "IN", "NUMBER", "Manual output", "%"),
    FAULT_RESET,
    signal("output", "OUT", "NUMBER", "Control output", "%", { minParameter: "outputMin", maxParameter: "outputMax" }),
    signal("processValue", "OUT", "NUMBER", "Process value"),
    signal("error", "OUT", "NUMBER", "Control error (setpoint minus process value)"),
    signal("atSetpoint", "OUT", "BOOL", "At setpoint"),
    signal("alarmHigh", "OUT", "BOOL", "Process value high"),
    signal("alarmLow", "OUT", "BOOL", "Process value low"),
    FAULTED,
  ],
  parameters: [
    {
      kind: "STRUCTURED",
      key: "source",
      label: "Process value source",
      role: "SOURCE",
      default: { kind: "MEASURED", signal: "value" },
      kinds: MEASURED_KINDS,
      description: "The output signal of the measured device that is the process value, scaled by gain and offset.",
    },
    number("kp", "Proportional gain", "RATING", 1, {
      unit: "%/unit",
      min: 0,
      max: 1000000,
      minInclusive: true,
      maxInclusive: true,
    }),
    number("ki", "Integral gain", "TIMING", 0.1, {
      unit: "%/(unit·s)",
      min: 0,
      max: 1000000,
      minInclusive: true,
      maxInclusive: true,
    }),
    number("kd", "Derivative gain", "TIMING", 0, {
      unit: "%·s/unit",
      min: 0,
      max: 1000000,
      minInclusive: true,
      maxInclusive: true,
    }),
    number("outputMin", "Output minimum", "LIMIT", 0, { unit: "%" }),
    number("outputMax", "Output maximum", "LIMIT", 100, { unit: "%", description: "Above the output minimum." }),
    number("setpoint", "Local setpoint", "INITIAL", 0, { description: "Used when the PLC gives no setpoint." }),
    {
      kind: "CHOICE",
      key: "action",
      label: "Action",
      role: "SHAPE",
      default: "REVERSE",
      choices: ["REVERSE", "DIRECT"],
      description:
        "REVERSE: the output rises when the process value is below the setpoint (heating); DIRECT: when it is above (cooling).",
    },
    number("deadband", "At-setpoint deadband", "LIMIT", 1, {
      min: 0,
      max: 1000000,
      minInclusive: true,
      maxInclusive: true,
    }),
    number("alarmHigh", "High alarm", "LIMIT", null, {
      description: "Process value at or above it raises the high alarm.",
    }),
    number("alarmLow", "Low alarm", "LIMIT", null, {
      description: "Process value at or below it raises the low alarm.",
    }),
  ],
  states: ["OFF", "AUTO", "MANUAL", "FAULTED"],
  faults: [
    fault("INPUT_FAILURE", "Process input failure", "CRITICAL", {
      effect: "output at its minimum, control suspended; reported",
    }),
  ],
  badQualityOnFaults: [],
  links: [
    {
      role: "measures",
      required: true,
      accepts: null,
      relationship: "MEASURES",
      peerIs: "TARGET",
      meaning: "the device whose output signal is the process value; required",
    },
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: [
      "an ideal parallel PID on a fixed step, derivative on the measurement, integral clamped against windup",
      "the integral resets when the controller is enabled",
    ],
    notModelled: ["auto-tuning", "setpoint ramps", "bumpless transfer", "output rate limits"],
  },
};

const SIGNAL_CONDITIONER: BehaviorProfile = {
  key: "SIGNAL_CONDITIONER",
  version: 1,
  simulatorType: "SIGNAL_CONDITIONER",
  runsOn: RUNTIME_ONLY,
  summary:
    "A signal conditioner or isolator: maps one output signal of the device it is linked to from its input range onto its output range, clamped; an open input reads the bottom of the output range with bad quality.",
  signals: [
    signal("value", "OUT", "NUMBER", "Conditioned value", undefined, {
      minParameter: "outputMin",
      maxParameter: "outputMax",
    }),
    FAULTED,
  ],
  parameters: [
    {
      kind: "STRUCTURED",
      key: "source",
      label: "Input signal",
      role: "SOURCE",
      default: { kind: "MEASURED", signal: "value" },
      kinds: MEASURED_KINDS,
      description: "The output signal of the measured device, scaled by gain and offset before the range mapping.",
    },
    number("inputMin", "Input range minimum", "LIMIT", 0),
    number("inputMax", "Input range maximum", "LIMIT", 100, { description: "Above the input range minimum." }),
    number("outputMin", "Output range minimum", "LIMIT", 0),
    number("outputMax", "Output range maximum", "LIMIT", 100, { description: "Above the output range minimum." }),
  ],
  states: ["GOOD", "BAD"],
  faults: [
    fault("OPEN_INPUT", "Open input", "WARNING", {
      quality: "BAD",
      effect: "reads the bottom of the output range, quality BAD; reported",
    }),
  ],
  badQualityOnFaults: ["OPEN_INPUT"],
  links: [
    {
      role: "measures",
      required: true,
      accepts: null,
      relationship: "MEASURES",
      peerIs: "TARGET",
      meaning: "the device whose output signal is conditioned; required",
    },
  ],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["linear range mapping, clamped"],
    notModelled: ["lag", "noise", "isolation errors", "calibration drift"],
  },
};

const ACTUATOR: BehaviorProfile = {
  key: "ACTUATOR",
  version: 1,
  simulatorType: "ACTUATOR",
  runsOn: RUNTIME_ONLY,
  summary:
    "A pneumatic cylinder: the extend and retract commands move the rod over its stroke at the extend and retract times and the end sensors report the ends; single-acting springs back when extend drops, double-acting holds with no command; lost air stops it (or springs it back) and stuck it does not move, neither reported.",
  signals: [
    signal("extend", "IN", "BOOL", "Extend command"),
    signal("retract", "IN", "BOOL", "Retract command (double-acting)"),
    signal("extended", "OUT", "BOOL", "Extended end sensor"),
    signal("retracted", "OUT", "BOOL", "Retracted end sensor"),
    signal("moving", "OUT", "BOOL", "Moving"),
    signal("position", "OUT", "NUMBER", "Rod position", "%", PERCENT),
  ],
  parameters: [
    {
      kind: "CHOICE",
      key: "kind",
      label: "Kind",
      role: "SHAPE",
      default: "DOUBLE_ACTING",
      choices: ["DOUBLE_ACTING", "SINGLE_ACTING"],
      description: "Double-acting holds with no command; single-acting springs back when extend drops.",
    },
    seconds("extendTimeS", "Extend time", 1, "Time for the full stroke out."),
    seconds("retractTimeS", "Retract time", 1, "Time for the full stroke back."),
    number("initialPosition", "Initial position", "INITIAL", 0, {
      unit: "%",
      min: 0,
      max: 100,
      minInclusive: true,
      maxInclusive: true,
    }),
  ],
  states: ["RETRACTED", "EXTENDING", "EXTENDED", "RETRACTING", "STOPPED"],
  faults: [
    fault("STUCK", "Stuck", "WARNING", { silent: true, effect: "does not move; not reported" }),
    fault("AIR_LOSS", "Air supply lost", "CRITICAL", {
      silent: true,
      effect: "a double-acting cylinder stops where it is, a single-acting one springs back; not reported",
    }),
    fault("END_SENSOR_FAULT", "End sensor disagreement", "WARNING", {
      silent: true,
      effect: "both end sensors read at once, whatever the rod does; not reported",
    }),
  ],
  badQualityOnFaults: [],
  links: [],
  protocol: "NONE",
  forcible: false,
  fidelity: {
    approximations: ["constant rod speed each way"],
    notModelled: ["cushioning", "pressure and flow", "load", "leakage"],
  },
};

/**
 * Every behaviour profile, by key. The keys are catalog simulator types: the ten the
 * server's simulator runs (`SIMULATED_TYPES`) and the runtime-only profiles of TASK-1011.
 */
/**
 * Every profile carries the generic faults of the fault standard (TASK-1014): OFFLINE
 * last in its list, and among the faults that make its feedback BAD.
 */
function withGenericFaults(profile: BehaviorProfile): BehaviorProfile {
  const faults = profile.faults.some((fault) => fault.code === OFFLINE.code)
    ? profile.faults
    : [...profile.faults, OFFLINE_FAULT];
  const badQualityOnFaults = profile.badQualityOnFaults.includes(OFFLINE.code)
    ? profile.badQualityOnFaults
    : [...profile.badQualityOnFaults, OFFLINE.code];
  return { ...profile, faults, badQualityOnFaults };
}

export const BEHAVIOR_PROFILES: Readonly<Record<string, BehaviorProfile>> = Object.fromEntries(
  [
    VFD,
    MOTOR,
    PUMP,
    load("FAN", "QUADRATIC"),
    load("CONVEYOR", "CONSTANT"),
    load("MIXER", "CONSTANT"),
    load("COMPRESSOR", "CONSTANT"),
    VALVE,
    SENSOR,
    SWITCH,
    RELAY,
    HEATER,
    INDICATOR,
    SOFT_STARTER,
    MOTOR_STARTER,
    SERVO_DRIVE,
    SERVO_MOTOR,
    ENCODER,
    PID_CONTROLLER,
    SIGNAL_CONDITIONER,
    ACTUATOR,
  ].map((profile) => [profile.key, withGenericFaults(profile)]),
);

export function findBehaviorProfile(key: string): BehaviorProfile | undefined {
  return Object.hasOwn(BEHAVIOR_PROFILES, key) ? BEHAVIOR_PROFILES[key] : undefined;
}

/** The commands and setpoints of a profile: what PLC logic drives. */
export const profileCommands = (profile: BehaviorProfile) => commands(profile.signals);
/** The feedback of a profile: what the device produces for the PLC. */
export const profileFeedback = (profile: BehaviorProfile) => feedback(profile.signals);

/**
 * Whether a value is allowed for a parameter of a profile, and if not, why. Used by the
 * catalog rules; the behaviour models validate again at run time.
 */
export function checkParameterValue(parameter: BehaviorParameter, value: unknown): string | null {
  switch (parameter.kind) {
    case "NUMBER": {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a finite number";
      if (parameter.min !== null && (parameter.minInclusive ? value < parameter.min : value <= parameter.min)) {
        return parameter.minInclusive ? `must be at least ${parameter.min}` : `must be greater than ${parameter.min}`;
      }
      if (parameter.max !== null && (parameter.maxInclusive ? value > parameter.max : value >= parameter.max)) {
        return parameter.maxInclusive ? `must be at most ${parameter.max}` : `must be less than ${parameter.max}`;
      }
      return null;
    }
    case "CHOICE":
      return typeof value === "string" && parameter.choices.includes(value)
        ? null
        : `must be one of ${parameter.choices.join(", ")}`;
    case "STRUCTURED": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return "must be an object";
      const kind = (value as { kind?: unknown }).kind;
      if (typeof kind !== "string" || !(kind in parameter.kinds)) {
        return `kind must be one of ${Object.keys(parameter.kinds).join(", ")}`;
      }
      const allowed = new Set<string>(["kind", ...parameter.kinds[kind]!]);
      const unknown = Object.keys(value).find((field) => !allowed.has(field));
      return unknown ? `has no field ${unknown} for kind ${kind}` : null;
    }
  }
}

/**
 * A parameter description as it travels over the runtime's API (`parameterSchema` of a
 * profile): absent fields instead of nulls and false flags, so the Go description and
 * this contract can be compared field by field.
 */
export function wireParameter(parameter: BehaviorParameter): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    key: parameter.key,
    label: parameter.label,
    kind: parameter.kind,
    role: parameter.role,
  };
  if (parameter.description) wire.description = parameter.description;
  switch (parameter.kind) {
    case "NUMBER":
      if (parameter.unit) wire.unit = parameter.unit;
      if (parameter.default !== null) wire.default = parameter.default;
      if (parameter.min !== null) wire.min = parameter.min;
      if (parameter.max !== null) wire.max = parameter.max;
      if (parameter.minInclusive) wire.minInclusive = true;
      if (parameter.maxInclusive) wire.maxInclusive = true;
      break;
    case "CHOICE":
      wire.default = parameter.default;
      wire.choices = [...parameter.choices];
      break;
    case "STRUCTURED":
      wire.default = parameter.default;
      wire.kinds = Object.fromEntries(Object.entries(parameter.kinds).map(([kind, fields]) => [kind, [...fields]]));
      break;
  }
  return wire;
}
