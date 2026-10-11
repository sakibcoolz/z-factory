import "server-only";
import { DomainError } from "@/lib/domain/errors";
import {
  DEVICE_FAULTS,
  DEVICE_SIGNALS,
  type FaultDefinition,
  findSignal,
  isLoadType,
  isSimulatedType,
  type LoadType,
  type Severity,
  type SimulatedType,
  type SimulationEventType,
} from "@/lib/domain/simulation";
import {
  type LoadParams,
  loadParamsSchema,
  type MotorParams,
  motorParamsSchema,
  parseParams,
  type PumpParams,
  pumpParamsSchema,
  type SensorParams,
  sensorParamsSchema,
  type SwitchParams,
  switchParamsSchema,
  type ValveParams,
  valveParamsSchema,
  type VfdParams,
  vfdParamsSchema,
} from "./params";

/**
 * The device simulation of one factory: a deterministic set of state machines advanced by
 * `step(dt)`. It has no clock, no I/O and no persistence; the runtime feeds it PLC outputs,
 * steps it, and carries its outputs back to the PLC.
 *
 * Models are approximations for control-software testing (docs/device-simulation.md).
 */

export type SignalValue = number | boolean;
export type Signals = Record<string, SignalValue>;

export type DeviceConfig = {
  id: string;
  name: string;
  type: SimulatedType;
  /** Raw behaviour parameters; validated against the type's schema, defaults applied. */
  params?: unknown;
  /** Catalog overrides of the generic fault behaviour, by fault code. */
  faults?: Record<string, { severity?: Severity; latching?: boolean }>;
  /** MOTOR: the drive (VFD) that supplies it. */
  driveId?: string;
  /** Motor-driven equipment: the motor on its shaft. */
  motorId?: string;
  /** SENSOR / SWITCH with a MEASURED source: the device it measures. */
  measuresId?: string;
};

export type SimulationConfig = { factoryId: string; devices: readonly DeviceConfig[] };

export type SimEvent = {
  type: SimulationEventType;
  deviceId: string;
  severity: Severity;
  payload: Record<string, unknown>;
};

export type DeviceSnapshot = {
  deviceId: string;
  name: string;
  type: SimulatedType;
  state: string;
  /** Any fault condition or trip, including faults the device itself does not report. */
  faulted: boolean;
  tripped: boolean;
  activeFaults: string[];
  quality: "GOOD" | "BAD";
  inputs: Signals;
  outputs: Signals;
};

type Common = {
  id: string;
  name: string;
  inputs: Signals;
  outputs: Signals;
  faults: Map<string, FaultDefinition>;
  activeFaults: Set<string>;
  tripped: boolean;
  resetInput: boolean;
  state: string;
  /** Whether the device was unavailable at the last step; it restarts when that changes (TASK-1014). */
  offline: boolean;
  lastQuality: "GOOD" | "BAD";
  /** The configuration it was created from, for the restart after a power cycle. */
  config: DeviceConfig;
};
type Vfd = Common & { type: "VFD"; params: VfdParams; frequency: number; motor?: Motor };
type Motor = Common & {
  type: "MOTOR";
  params: MotorParams;
  speed: number;
  current: number;
  energized: boolean;
  drive?: Vfd;
  load?: Load;
};
type Pump = Common & { type: "PUMP"; params: PumpParams; speedFraction: number; motor?: Motor };
type GenericLoad = Common & {
  type: Exclude<LoadType, "PUMP">;
  params: LoadParams;
  profile: "QUADRATIC" | "CONSTANT";
  speedFraction: number;
  motor?: Motor;
};
type Load = Pump | GenericLoad;
type Valve = Common & { type: "VALVE"; params: ValveParams; position: number };
type Sensor = Common & {
  type: "SENSOR";
  params: SensorParams;
  value: number;
  quality: "GOOD" | "BAD";
  override: number | null;
  random: () => number;
  sample: number;
  nextSampleAt: number;
  lastEmitted: number;
  measured?: Device;
};
type Switch = Common & {
  type: "SWITCH";
  params: SwitchParams;
  on: boolean;
  override: boolean | null;
  measured?: Device;
};
type Device = Vfd | Motor | Load | Valve | Sensor | Switch;

const STATE_EVENT: Partial<Record<SimulatedType, SimulationEventType>> = {
  VFD: "VFD_STATE_CHANGED",
  MOTOR: "MOTOR_STATE_CHANGED",
  PUMP: "PUMP_STATE_CHANGED",
  VALVE: "VALVE_STATE_CHANGED",
  SENSOR: "SENSOR_VALUE_CHANGED",
};

/** Below this share of rated speed a shaft counts as standing still. */
const STANDSTILL = 0.01;

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), max);

/** Moves `current` towards `target` by at most `maxDelta`. */
function approach(current: number, target: number, maxDelta: number): number {
  const delta = target - current;
  return Math.abs(delta) <= maxDelta ? target : current + Math.sign(delta) * maxDelta;
}

/** Small seeded generator (mulberry32) so RANDOM sources are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const hasLatchingFault = (device: Common) =>
  [...device.activeFaults].some((code) => device.faults.get(code)?.latching === true);

/** What the device reports on its own fault output: trips and faults it can detect itself. */
const reportsFault = (device: Common) =>
  device.tripped || [...device.activeFaults].some((code) => device.faults.get(code)?.silent !== true);

/**
 * A latching fault trips the device. The trip stays after its cause is gone and is
 * released by a rising edge on the PLC's `faultReset` signal (or an operator reset).
 */
function updateTrip(device: Common): void {
  const latching = hasLatchingFault(device);
  if (latching) device.tripped = true;
  const resetInput = device.inputs.faultReset === true;
  if (device.tripped && !latching && resetInput && !device.resetInput) device.tripped = false;
  device.resetInput = resetInput;
}

function stepVfd(vfd: Vfd, dt: number): void {
  if (vfd.tripped) {
    // A tripped drive removes its output at once; the motor coasts.
    vfd.frequency = 0;
    vfd.state = "FAULTED";
    return;
  }
  const { maxFrequencyHz, accelTimeS, decelTimeS } = vfd.params;
  const setpoint = typeof vfd.inputs.frequencySetpoint === "number" ? vfd.inputs.frequencySetpoint : 0;
  const magnitude = clamp(setpoint, 0, maxFrequencyHz);
  const target = vfd.inputs.run === true ? (vfd.inputs.reverse === true ? -magnitude : magnitude) : 0;

  // A change of direction first ramps down to zero, then up the other way.
  const reversing = vfd.frequency !== 0 && target !== 0 && Math.sign(vfd.frequency) !== Math.sign(target);
  const accelerating = !reversing && Math.abs(target) > Math.abs(vfd.frequency);
  const rate = maxFrequencyHz / (accelerating ? accelTimeS : decelTimeS);
  vfd.frequency = approach(vfd.frequency, reversing ? 0 : target, rate * dt);

  if (vfd.frequency === target) vfd.state = target === 0 ? "STOPPED" : "RUNNING";
  else vfd.state = accelerating ? "ACCELERATING" : "DECELERATING";
}

/** Shaft torque the load asks for, as a share of rated torque, at speed fraction `n`. */
function loadTorque(load: Load, n: number): number {
  if (load.type === "PUMP") return (load.activeFaults.has("DRY_RUN") ? 0.2 : 1) * n * n;
  if (load.profile === "QUADRATIC") return n * n;
  return n > STANDSTILL ? 1 : 0;
}

function stepMotor(motor: Motor, dt: number): void {
  const p = motor.params;
  let supplyHz = 0;
  if (!motor.tripped)
    supplyHz = motor.drive ? motor.drive.frequency : motor.inputs.run === true ? p.ratedFrequencyHz : 0;

  // Speed follows the supply frequency with a first-order lag; slip is not modelled.
  const target = (p.ratedSpeedRpm * supplyHz) / p.ratedFrequencyHz;
  const timeConstant = supplyHz !== 0 ? p.timeConstantS : p.coastTimeConstantS;
  let speed = motor.speed + (target - motor.speed) * (1 - Math.exp(-dt / timeConstant));
  if (Math.abs(target - speed) < p.ratedSpeedRpm * 0.001) speed = target;
  motor.speed = speed;
  motor.energized = supplyHz !== 0;

  const n = Math.abs(speed) / p.ratedSpeedRpm;
  const torque = motor.load ? Math.min(loadTorque(motor.load, n), 1.5) : 0;
  motor.current = motor.energized ? p.ratedCurrentA * (p.noLoadCurrentRatio + (1 - p.noLoadCurrentRatio) * torque) : 0;

  if (motor.tripped) motor.state = "FAULTED";
  else if (motor.energized) motor.state = "RUNNING";
  else motor.state = n > STANDSTILL ? "COASTING" : "STOPPED";
}

function stepLoad(load: Load): void {
  load.speedFraction = load.motor ? Math.abs(load.motor.speed) / load.motor.params.ratedSpeedRpm : 0;
  if (load.type === "PUMP" && load.activeFaults.has("DRY_RUN")) load.state = "DRY_RUN";
  else load.state = load.speedFraction > STANDSTILL ? "RUNNING" : "STOPPED";
}

function stepValve(valve: Valve, dt: number): void {
  const inputs = valve.inputs;
  let target = valve.position;
  if (typeof inputs.positionSetpoint === "number") target = clamp(inputs.positionSetpoint, 0, 100);
  else if ("close" in inputs) {
    // Double-acting: holds its position when neither (or both) commands are present.
    if (inputs.open === true && inputs.close !== true) target = 100;
    else if (inputs.close === true && inputs.open !== true) target = 0;
  } else target = inputs.open === true ? 100 : 0;

  const frozen = valve.tripped || valve.activeFaults.has("STUCK");
  if (!frozen) valve.position = approach(valve.position, target, (100 / valve.params.travelTimeS) * dt);

  if (valve.tripped) valve.state = "FAULTED";
  else if (!frozen && valve.position !== target) valve.state = target > valve.position ? "OPENING" : "CLOSING";
  else if (valve.position >= 99.5) valve.state = "OPEN";
  else valve.state = valve.position <= 0.5 ? "CLOSED" : "STOPPED";
}

const numeric = (value: SignalValue | undefined) => (typeof value === "number" ? value : value === true ? 1 : 0);

function sensorSource(sensor: Sensor, elapsedS: number): number {
  const source = sensor.params.source;
  switch (source.kind) {
    case "CONSTANT":
      return source.value;
    case "RAMP":
      return source.from + (source.to - source.from) * ((elapsedS % source.periodS) / source.periodS);
    case "SINE":
      return (
        (source.min + source.max) / 2 +
        ((source.max - source.min) / 2) * Math.sin((2 * Math.PI * elapsedS) / source.periodS)
      );
    case "RANDOM":
      while (elapsedS >= sensor.nextSampleAt) {
        sensor.sample = source.min + (source.max - source.min) * sensor.random();
        sensor.nextSampleAt += source.intervalS;
      }
      return sensor.sample;
    case "MEASURED":
      return numeric(sensor.measured?.outputs[source.signal]) * source.gain + source.offset;
  }
}

function stepSensor(sensor: Sensor, dt: number, elapsedS: number): void {
  const p = sensor.params;
  if (sensor.activeFaults.has("BAD_QUALITY")) {
    // A lost signal reads as the bottom of the range, like an open current loop.
    sensor.quality = "BAD";
    sensor.value = p.rangeMin ?? 0;
  } else {
    sensor.quality = "GOOD";
    if (!sensor.tripped && !sensor.activeFaults.has("STUCK")) {
      const raw = sensor.override ?? sensorSource(sensor, elapsedS);
      const next =
        p.timeConstantS > 0 ? sensor.value + (raw - sensor.value) * (1 - Math.exp(-dt / p.timeConstantS)) : raw;
      sensor.value = clamp(next, p.rangeMin ?? -Infinity, p.rangeMax ?? Infinity);
    }
  }
  sensor.state = sensor.quality;
}

function stepSwitch(device: Switch): void {
  if (!device.tripped && !device.activeFaults.has("STUCK")) {
    const source = device.params.source;
    if (device.override !== null) device.on = device.override;
    else if (source.kind === "CONSTANT") device.on = source.state;
    else {
      const value = numeric(device.measured?.outputs[source.signal]);
      if (value >= source.onAbove) device.on = true;
      else if (value <= (source.offBelow ?? source.onAbove)) device.on = false;
    }
  }
  device.state = device.on ? "ON" : "OFF";
}

function outputsOf(device: Device): Signals {
  const faulted = reportsFault(device);
  switch (device.type) {
    case "VFD":
      return {
        running: !device.tripped && (device.inputs.run === true || device.frequency !== 0),
        atSetpoint: device.state === "RUNNING",
        faulted,
        actualFrequency: Math.abs(device.frequency),
        outputCurrent: device.motor && device.frequency !== 0 ? device.motor.current : 0,
      };
    case "MOTOR":
      return { running: device.energized, faulted, actualSpeed: Math.abs(device.speed), current: device.current };
    case "PUMP": {
      const dry = device.activeFaults.has("DRY_RUN");
      const n = device.speedFraction;
      return {
        running: n > STANDSTILL,
        faulted,
        // Affinity laws against a fixed system: flow ∝ speed, pressure ∝ speed².
        flow: dry ? 0 : device.params.ratedFlow * n,
        pressure: dry ? 0 : device.params.ratedPressure * n * n,
      };
    }
    case "VALVE": {
      // A limit-switch disagreement: both end switches read at once, whatever the position.
      const disagree = device.activeFaults.has("LIMIT_SWITCH_FAULT");
      return {
        position: device.position,
        opened: disagree || device.position >= 99.5,
        closed: disagree || device.position <= 0.5,
        faulted,
      };
    }
    case "SENSOR":
      return { value: device.value, faulted };
    case "SWITCH":
      return { state: device.on };
    default:
      return {
        running: device.speedFraction > STANDSTILL,
        faulted,
        output: device.params.ratedOutput * device.speedFraction,
      };
  }
}

/** What an unavailable device's feedback reads: every output false or zero, as powered-down wiring reads. */
function deEnergized(device: Device): Signals {
  return Object.fromEntries(
    DEVICE_SIGNALS[device.type]
      .filter((signal) => signal.direction === "OUT")
      .map((signal) => [signal.key, signal.kind === "BOOL" ? false : 0]),
  );
}

function faultDefinitions(config: DeviceConfig): Map<string, FaultDefinition> {
  return new Map(
    DEVICE_FAULTS[config.type].map((fault) => {
      const override = config.faults?.[fault.code];
      return [
        fault.code,
        { ...fault, severity: override?.severity ?? fault.severity, latching: override?.latching ?? fault.latching },
      ];
    }),
  );
}

function createDevice(config: DeviceConfig): Device {
  if (!isSimulatedType(config.type)) {
    throw new DomainError("INCOMPATIBLE", `Device type ${String(config.type)} is not simulated.`, {
      rule: "simulated-type",
    });
  }
  const common: Common = {
    id: config.id,
    name: config.name,
    inputs: {},
    outputs: {},
    faults: faultDefinitions(config),
    activeFaults: new Set(),
    tripped: false,
    resetInput: false,
    state: "STOPPED",
    offline: false,
    lastQuality: "GOOD",
    config,
  };
  const { type, name } = config;
  switch (type) {
    case "VFD":
      return { ...common, type, params: parseParams(vfdParamsSchema, config.params, name), frequency: 0 };
    case "MOTOR":
      return {
        ...common,
        type,
        params: parseParams(motorParamsSchema, config.params, name),
        speed: 0,
        current: 0,
        energized: false,
      };
    case "PUMP":
      return { ...common, type, params: parseParams(pumpParamsSchema, config.params, name), speedFraction: 0 };
    case "VALVE": {
      const params = parseParams(valveParamsSchema, config.params, name);
      return { ...common, type, params, position: params.initialPosition };
    }
    case "SENSOR": {
      const params = parseParams(sensorParamsSchema, config.params, name);
      const initial = params.initialValue ?? params.rangeMin ?? 0;
      return {
        ...common,
        type,
        params,
        value: initial,
        quality: "GOOD",
        override: null,
        random: seededRandom(params.source.kind === "RANDOM" ? params.source.seed : 1),
        sample: 0,
        nextSampleAt: 0,
        lastEmitted: initial,
      };
    }
    case "SWITCH":
      return {
        ...common,
        type,
        params: parseParams(switchParamsSchema, config.params, name),
        on: false,
        override: null,
      };
    default: {
      const params = parseParams(loadParamsSchema, config.params, name);
      const profile = params.loadProfile ?? (type === "FAN" ? "QUADRATIC" : "CONSTANT");
      return { ...common, type, params, profile, speedFraction: 0 };
    }
  }
}

const invariant = (message: string, rule: string, details: Record<string, unknown> = {}) =>
  new DomainError("INVARIANT", message, { rule, ...details });

export class FactorySimulation {
  readonly factoryId: string;
  private readonly devices = new Map<string, Device>();
  private readonly vfds: Vfd[] = [];
  private readonly motors: Motor[] = [];
  private readonly loads: Load[] = [];
  private readonly valves: Valve[] = [];
  private readonly sensors: Sensor[] = [];
  private readonly switches: Switch[] = [];
  private elapsedS = 0;

  constructor(config: SimulationConfig) {
    this.factoryId = config.factoryId;
    for (const deviceConfig of config.devices) {
      if (this.devices.has(deviceConfig.id)) throw invariant("A device is configured twice.", "unique-device");
      const device = createDevice(deviceConfig);
      this.devices.set(device.id, device);
      if (device.type === "VFD") this.vfds.push(device);
      else if (device.type === "MOTOR") this.motors.push(device);
      else if (device.type === "VALVE") this.valves.push(device);
      else if (device.type === "SENSOR") this.sensors.push(device);
      else if (device.type === "SWITCH") this.switches.push(device);
      else this.loads.push(device);
    }
    for (const deviceConfig of config.devices) this.link(deviceConfig);
    // Settle initial states and outputs without reporting them as changes.
    this.advance(0);
  }

  private link(config: DeviceConfig): void {
    const device = this.require(config.id);
    if (device.type === "MOTOR" && config.driveId) {
      const drive = this.devices.get(config.driveId);
      if (drive?.type !== "VFD") throw invariant(`${device.name} is driven by a device that is not a VFD.`, "drive");
      if (drive.motor) {
        throw invariant(
          `${drive.name} already drives ${drive.motor.name}: one VFD drives one motor.`,
          "one-motor-per-drive",
        );
      }
      drive.motor = device;
      device.drive = drive;
    }
    if (isLoadType(device.type) && config.motorId) {
      const load = device as Load;
      const motor = this.devices.get(config.motorId);
      if (motor?.type !== "MOTOR")
        throw invariant(`${device.name} is driven by a device that is not a motor.`, "motor");
      if (motor.load) {
        throw invariant(
          `${motor.name} already drives ${motor.load.name}: one motor drives one load.`,
          "one-load-per-motor",
        );
      }
      motor.load = load;
      load.motor = motor;
    }
    if (device.type === "SENSOR" || device.type === "SWITCH") {
      const source = device.params.source;
      if (source.kind !== "MEASURED") return;
      const measured = config.measuresId ? this.devices.get(config.measuresId) : undefined;
      if (!measured || measured.type === "SENSOR" || measured.type === "SWITCH") {
        throw new DomainError("VALIDATION", `${device.name} has a measured source but measures no simulated device.`, {
          rule: "measured-device",
          device: device.name,
        });
      }
      const signal = findSignal(measured.type, source.signal);
      if (signal?.direction !== "OUT" || (device.type === "SWITCH" && signal.kind !== "NUMBER")) {
        throw new DomainError("VALIDATION", `${measured.name} has no output signal "${source.signal}" to measure.`, {
          rule: "measured-signal",
          device: device.name,
        });
      }
      device.measured = measured;
    }
  }

  private require(deviceId: string): Device {
    const device = this.devices.get(deviceId);
    if (!device) throw new DomainError("NOT_FOUND", "The device is not part of this simulation.", { deviceId });
    return device;
  }

  private all(): Device[] {
    return [...this.vfds, ...this.motors, ...this.loads, ...this.valves, ...this.sensors, ...this.switches];
  }

  has(deviceId: string): boolean {
    return this.devices.has(deviceId);
  }

  /** Replaces the PLC-driven inputs of a device. Signals that are not listed count as not wired. */
  setInputs(deviceId: string, inputs: Signals): void {
    this.require(deviceId).inputs = { ...inputs };
  }

  outputs(deviceId: string): Signals {
    return this.require(deviceId).outputs;
  }

  /** Whether the device's signal can be trusted: BAD for a sensor that lost its signal. Undefined for an unknown device. */
  /**
   * Rebuilds a device's physics from its configuration when its supply goes or returns:
   * the links, inputs and faults stay; the state restarts, and a trip does not survive.
   */
  private powerCycle(device: Device): void {
    const fresh = createDevice(device.config);
    switch (device.type) {
      case "VFD":
        device.frequency = (fresh as Vfd).frequency;
        break;
      case "MOTOR": {
        const motor = fresh as Motor;
        device.speed = motor.speed;
        device.current = motor.current;
        device.energized = motor.energized;
        break;
      }
      case "VALVE":
        device.position = (fresh as Valve).position;
        break;
      case "SENSOR": {
        const sensor = fresh as Sensor;
        device.value = sensor.value;
        device.quality = sensor.quality;
        device.sample = sensor.sample;
        device.nextSampleAt = sensor.nextSampleAt;
        device.lastEmitted = sensor.lastEmitted;
        device.random = sensor.random;
        break;
      }
      case "SWITCH":
        device.on = (fresh as Switch).on;
        break;
      default:
        device.speedFraction = (fresh as Load).speedFraction;
    }
    device.tripped = false;
    device.resetInput = false;
  }

  /**
   * Quality of a device's feedback (TASK-1014): BAD while it is unavailable, while a
   * sensor has lost its signal, and while the device it measures is BAD.
   */
  quality(deviceId: string): "GOOD" | "BAD" | undefined {
    const device = this.devices.get(deviceId);
    if (!device) return undefined;
    if (device.activeFaults.has("OFFLINE")) return "BAD";
    if (device.type === "SENSOR" && device.quality === "BAD") return "BAD";
    const measured = device.type === "SENSOR" || device.type === "SWITCH" ? device.measured : undefined;
    if (measured && measured !== device && this.quality(measured.id) === "BAD") return "BAD";
    return "GOOD";
  }

  /** Advances every device by `dtS` seconds and returns the meaningful changes. */
  step(dtS: number): SimEvent[] {
    if (!Number.isFinite(dtS) || dtS < 0) {
      throw new DomainError("VALIDATION", "The simulation step must be a non-negative time.", { rule: "step" });
    }
    return this.advance(dtS);
  }

  private advance(dt: number): SimEvent[] {
    this.elapsedS += dt;
    const devices = this.all();
    const before = devices.map((device) => device.state);

    for (const device of devices) updateTrip(device);
    // An unavailable device is not stepped and reads de-energized. Losing the supply wipes
    // its physics at once, so peers read it as gone; it comes back from the same initial
    // state, and a trip does not survive the power cycle (TASK-1014).
    for (const device of devices) {
      const offline = device.activeFaults.has("OFFLINE");
      if (offline !== device.offline) this.powerCycle(device);
      device.offline = offline;
    }
    const live = <T extends Device>(list: readonly T[]) => list.filter((device) => !device.offline);
    for (const vfd of live(this.vfds)) stepVfd(vfd, dt);
    for (const motor of live(this.motors)) stepMotor(motor, dt);
    for (const load of live(this.loads)) stepLoad(load);
    for (const valve of live(this.valves)) stepValve(valve, dt);
    for (const device of [...this.vfds, ...this.motors, ...this.loads, ...this.valves]) {
      device.outputs = device.offline ? deEnergized(device) : outputsOf(device);
      if (device.offline) device.state = "OFFLINE";
    }
    // Sensors and switches observe what the other devices produced in this step.
    for (const sensor of live(this.sensors)) stepSensor(sensor, dt, this.elapsedS);
    for (const device of live(this.switches)) stepSwitch(device);
    for (const device of [...this.sensors, ...this.switches]) {
      device.outputs = device.offline ? deEnergized(device) : outputsOf(device);
      if (device.offline) device.state = "OFFLINE";
    }

    const events: SimEvent[] = [];
    for (const device of devices) {
      const quality = this.quality(device.id) ?? "GOOD";
      if (quality === device.lastQuality) continue;
      events.push({
        type: "QUALITY_CHANGED",
        deviceId: device.id,
        severity: quality === "BAD" ? "WARNING" : "INFO",
        payload: { from: device.lastQuality, to: quality, activeFaults: [...device.activeFaults] },
      });
      device.lastQuality = quality;
    }
    devices.forEach((device, index) => {
      const from = before[index];
      const deadband = device.type === "SENSOR" ? device.params.eventDeadband : undefined;
      const moved =
        device.type === "SENSOR" && deadband !== undefined && Math.abs(device.value - device.lastEmitted) >= deadband;
      if (device.state === from && !moved) return;
      if (device.type === "SENSOR") device.lastEmitted = device.value;
      events.push({
        type: STATE_EVENT[device.type] ?? "DEVICE_STATE_CHANGED",
        deviceId: device.id,
        severity: device.state === "FAULTED" || device.state === "OFFLINE" ? "CRITICAL" : "INFO",
        payload: { from, to: device.state, outputs: { ...device.outputs }, activeFaults: [...device.activeFaults] },
      });
    });
    return events;
  }

  snapshot(): DeviceSnapshot[] {
    return this.all().map((device) => ({
      deviceId: device.id,
      name: device.name,
      type: device.type,
      state: device.state,
      faulted: device.tripped || device.activeFaults.size > 0,
      tripped: device.tripped,
      activeFaults: [...device.activeFaults],
      quality: this.quality(device.id) ?? "GOOD",
      inputs: { ...device.inputs },
      outputs: { ...device.outputs },
    }));
  }

  private fault(device: Device, code: string): FaultDefinition {
    const fault = device.faults.get(code);
    if (!fault) {
      throw new DomainError("VALIDATION", `${device.name} does not support the fault ${code}.`, {
        rule: "supported-fault",
        supported: [...device.faults.keys()],
      });
    }
    return fault;
  }

  /** Makes a fault condition present. Its effect shows from the next step. */
  injectFault(deviceId: string, code: string): SimEvent {
    const device = this.require(deviceId);
    const fault = this.fault(device, code);
    if (device.activeFaults.has(code)) {
      throw new DomainError("CONFLICT", `${fault.name} is already active on ${device.name}.`, { rule: "fault-active" });
    }
    device.activeFaults.add(code);
    return {
      type: "FAULT_INJECTED",
      deviceId,
      severity: fault.severity,
      payload: { code, name: fault.name, latching: fault.latching },
    };
  }

  /** Removes a fault condition. A device tripped by a latching fault stays tripped until reset. */
  clearFault(deviceId: string, code: string): SimEvent {
    const device = this.require(deviceId);
    const fault = this.fault(device, code);
    if (!device.activeFaults.delete(code)) {
      throw new DomainError("CONFLICT", `${fault.name} is not active on ${device.name}.`, { rule: "fault-not-active" });
    }
    return {
      type: "FAULT_CLEARED",
      deviceId,
      severity: "INFO",
      payload: { code, name: fault.name, stillTripped: fault.latching },
    };
  }

  /** Operator reset at the device, like the reset key of a drive. Refused while the cause is present. */
  reset(deviceId: string): SimEvent {
    const device = this.require(deviceId);
    if (hasLatchingFault(device)) {
      throw new DomainError("CONFLICT", `${device.name} cannot be reset while its fault is still active.`, {
        rule: "fault-active",
      });
    }
    const wasTripped = device.tripped;
    device.tripped = false;
    return {
      type: "DEVICE_RESET",
      deviceId,
      severity: "INFO",
      payload: { wasTripped, activeFaults: [...device.activeFaults] },
    };
  }

  /** Forces the simulated value of a sensor or switch; `null` returns it to its source. */
  /** The sensors and switches whose value is forced, with that value. */
  forced(): Array<{ deviceId: string; name: string; value: SignalValue }> {
    return [...this.sensors, ...this.switches].flatMap((device) =>
      device.override === null ? [] : [{ deviceId: device.id, name: device.name, value: device.override }],
    );
  }

  setOverride(deviceId: string, value: SignalValue | null): SimEvent {
    const device = this.require(deviceId);
    const accepted =
      (device.type === "SENSOR" && (value === null || (typeof value === "number" && Number.isFinite(value)))) ||
      (device.type === "SWITCH" && (value === null || typeof value === "boolean"));
    if (!accepted) {
      throw new DomainError("INCOMPATIBLE", "Only a sensor (number) or a switch (true/false) can be forced.", {
        rule: "forcible-device",
      });
    }
    if (device.type === "SENSOR") device.override = value as number | null;
    if (device.type === "SWITCH") device.override = value as boolean | null;
    return {
      type: value === null ? "SIMULATED_INPUT_RELEASED" : "SIMULATED_INPUT_FORCED",
      deviceId,
      severity: "INFO",
      payload: value === null ? {} : { value },
    };
  }
}
