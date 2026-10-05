// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import { DEVICE_FAULTS, DEVICE_SIGNALS, SIMULATED_TYPES } from "@/lib/domain/simulation";
import { type DeviceConfig, FactorySimulation, type SimEvent } from "./engine";

const TICK = 0.1;

/** Steps the simulation for `seconds` of simulated time and collects every event. */
function run(simulation: FactorySimulation, seconds: number): SimEvent[] {
  const events: SimEvent[] = [];
  for (let step = 0; step < Math.round(seconds / TICK); step += 1) events.push(...simulation.step(TICK));
  return events;
}

/** VFD → motor → pump, with a pressure sensor on the pump. */
function chain(suffix: string, overrides: Partial<Record<"vfd" | "motor" | "pump" | "sensor", unknown>> = {}) {
  return [
    { id: `vfd${suffix}`, name: `VFD${suffix}`, type: "VFD", params: overrides.vfd },
    { id: `motor${suffix}`, name: `M${suffix}`, type: "MOTOR", driveId: `vfd${suffix}`, params: overrides.motor },
    { id: `pump${suffix}`, name: `P${suffix}`, type: "PUMP", motorId: `motor${suffix}`, params: overrides.pump },
    {
      id: `pt${suffix}`,
      name: `PT${suffix}`,
      type: "SENSOR",
      measuresId: `pump${suffix}`,
      params: overrides.sensor ?? { source: { kind: "MEASURED", signal: "pressure" } },
    },
  ] satisfies DeviceConfig[];
}

const simulate = (devices: DeviceConfig[]) => new FactorySimulation({ factoryId: "factory", devices });

function expectDomainError(action: () => unknown, code: string, rule: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    expect((error as DomainError).details.rule).toBe(rule);
    return;
  }
  throw new Error("expected a DomainError");
}

describe("simulation vocabulary", () => {
  it("defines signals and faults for every simulated type", () => {
    for (const type of SIMULATED_TYPES) {
      expect(DEVICE_SIGNALS[type].length, type).toBeGreaterThan(0);
      expect(new Set(DEVICE_SIGNALS[type].map((signal) => signal.key)).size).toBe(DEVICE_SIGNALS[type].length);
      expect(DEVICE_FAULTS[type]).toBeDefined();
    }
  });
});

describe("VFD", () => {
  it("ramps to the setpoint at the configured rate and reports its state", () => {
    const simulation = simulate(chain("1", { vfd: { accelTimeS: 5, decelTimeS: 10 } }));
    expect(simulation.outputs("vfd1")).toMatchObject({ running: false, actualFrequency: 0, faulted: false });

    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 40 });
    const events = run(simulation, 2);
    // 50 Hz in 5 s = 10 Hz/s.
    expect(simulation.outputs("vfd1").actualFrequency).toBeCloseTo(20, 6);
    expect(simulation.outputs("vfd1")).toMatchObject({ running: true, atSetpoint: false });
    expect(events.find((event) => event.deviceId === "vfd1")).toMatchObject({
      type: "VFD_STATE_CHANGED",
      payload: { from: "STOPPED", to: "ACCELERATING" },
    });

    run(simulation, 2.5);
    expect(simulation.outputs("vfd1")).toMatchObject({ actualFrequency: 40, atSetpoint: true });

    // Stop: 50 Hz in 10 s = 5 Hz/s down.
    simulation.setInputs("vfd1", { run: false, frequencySetpoint: 40 });
    run(simulation, 2);
    expect(simulation.outputs("vfd1").actualFrequency).toBeCloseTo(30, 6);
    expect(simulation.outputs("vfd1").running).toBe(true);
    run(simulation, 6.5);
    expect(simulation.outputs("vfd1")).toMatchObject({ actualFrequency: 0, running: false });
  });

  it("limits the setpoint to its maximum frequency and ignores a setpoint without a run command", () => {
    const simulation = simulate(chain("1"));
    simulation.setInputs("vfd1", { run: false, frequencySetpoint: 45 });
    run(simulation, 3);
    expect(simulation.outputs("vfd1").actualFrequency).toBe(0);

    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 400 });
    run(simulation, 10);
    expect(simulation.outputs("vfd1").actualFrequency).toBe(50);
  });

  it("ramps through zero when the direction changes", () => {
    const simulation = simulate(chain("1", { vfd: { accelTimeS: 5, decelTimeS: 5 } }));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 20 });
    run(simulation, 3);
    simulation.setInputs("vfd1", { run: true, reverse: true, frequencySetpoint: 20 });
    run(simulation, 1);
    expect(simulation.outputs("vfd1").actualFrequency).toBeCloseTo(10, 6);
    run(simulation, 4);
    expect(simulation.outputs("vfd1")).toMatchObject({ actualFrequency: 20, atSetpoint: true });
  });

  it("trips on an injected fault, stays tripped after the cause is cleared, and resets on a rising edge", () => {
    const simulation = simulate(chain("1"));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    run(simulation, 8);
    expect(simulation.outputs("motor1").running).toBe(true);

    expect(simulation.injectFault("vfd1", "OVERCURRENT")).toMatchObject({
      type: "FAULT_INJECTED",
      severity: "CRITICAL",
      payload: { code: "OVERCURRENT", latching: true },
    });
    const events = simulation.step(TICK);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "VFD_STATE_CHANGED", severity: "CRITICAL", deviceId: "vfd1" }),
    );
    expect(simulation.outputs("vfd1")).toMatchObject({ faulted: true, running: false, actualFrequency: 0 });
    // The motor lost its supply and coasts down instead of stopping at once.
    expect(simulation.outputs("motor1")).toMatchObject({ running: false, current: 0 });
    expect(simulation.outputs("motor1").actualSpeed).toBeGreaterThan(1000);

    // A reset while the cause is present does nothing.
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50, faultReset: true });
    run(simulation, 1);
    expect(simulation.outputs("vfd1").faulted).toBe(true);
    expectDomainError(() => simulation.reset("vfd1"), "CONFLICT", "fault-active");

    // Clearing the cause leaves the drive tripped; a held reset signal is not a new edge.
    expect(simulation.clearFault("vfd1", "OVERCURRENT").payload).toMatchObject({ stillTripped: true });
    run(simulation, 1);
    expect(simulation.outputs("vfd1").faulted).toBe(true);

    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50, faultReset: false });
    simulation.step(TICK);
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50, faultReset: true });
    run(simulation, 6);
    expect(simulation.outputs("vfd1")).toMatchObject({ faulted: false, actualFrequency: 50 });
  });

  it("can be reset by the operator once the cause is gone", () => {
    const simulation = simulate(chain("1"));
    simulation.injectFault("vfd1", "OVERTEMPERATURE");
    simulation.step(TICK);
    simulation.clearFault("vfd1", "OVERTEMPERATURE");
    expect(simulation.reset("vfd1")).toMatchObject({ type: "DEVICE_RESET", payload: { wasTripped: true } });
    simulation.step(TICK);
    expect(simulation.snapshot().find((device) => device.deviceId === "vfd1")).toMatchObject({
      state: "STOPPED",
      tripped: false,
      faulted: false,
    });
  });

  it("rejects unknown and repeated faults", () => {
    const simulation = simulate(chain("1"));
    expectDomainError(() => simulation.injectFault("vfd1", "DRY_RUN"), "VALIDATION", "supported-fault");
    simulation.injectFault("vfd1", "OVERCURRENT");
    expectDomainError(() => simulation.injectFault("vfd1", "OVERCURRENT"), "CONFLICT", "fault-active");
    expectDomainError(() => simulation.clearFault("vfd1", "OVERTEMPERATURE"), "CONFLICT", "fault-not-active");
  });
});

describe("one VFD drives one primary motor", () => {
  it("refuses a second motor on the same drive", () => {
    expectDomainError(
      () =>
        simulate([
          { id: "vfd", name: "VFD-01", type: "VFD" },
          { id: "m1", name: "M-01", type: "MOTOR", driveId: "vfd" },
          { id: "m2", name: "M-02", type: "MOTOR", driveId: "vfd" },
        ]),
      "INVARIANT",
      "one-motor-per-drive",
    );
  });

  it("refuses a drive that is not a VFD, a load on a non-motor and a second load on a motor", () => {
    expectDomainError(
      () =>
        simulate([
          { id: "m1", name: "M-01", type: "MOTOR" },
          { id: "m2", name: "M-02", type: "MOTOR", driveId: "m1" },
        ]),
      "INVARIANT",
      "drive",
    );
    expectDomainError(
      () =>
        simulate([
          { id: "vfd", name: "VFD-01", type: "VFD" },
          { id: "p", name: "P-01", type: "PUMP", motorId: "vfd" },
        ]),
      "INVARIANT",
      "motor",
    );
    expectDomainError(
      () =>
        simulate([
          { id: "m", name: "M-01", type: "MOTOR" },
          { id: "p1", name: "P-01", type: "PUMP", motorId: "m" },
          { id: "p2", name: "P-02", type: "PUMP", motorId: "m" },
        ]),
      "INVARIANT",
      "one-load-per-motor",
    );
  });
});

describe("motor", () => {
  it("follows its drive: speed proportional to frequency, current rising with the pump load", () => {
    const simulation = simulate(chain("1"));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 25 });
    run(simulation, 10);
    const half = simulation.outputs("motor1");
    expect(half.actualSpeed).toBeCloseTo(725, 0);
    // 35 % no-load current plus 65 % × (0.5)² of rated 10 A.
    expect(half.current).toBeCloseTo(3.5 + 6.5 * 0.25, 1);
    expect(simulation.outputs("vfd1").outputCurrent).toBe(half.current);

    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    run(simulation, 10);
    expect(simulation.outputs("motor1")).toMatchObject({ actualSpeed: 1450, running: true });
    expect(simulation.outputs("motor1").current).toBeCloseTo(10, 6);
  });

  it("starts direct-on-line from a contactor command when it has no drive", () => {
    const events: SimEvent[] = [];
    const simulation = simulate([{ id: "m", name: "M-01", type: "MOTOR", params: { timeConstantS: 1 } }]);
    simulation.setInputs("m", { run: true });
    events.push(...run(simulation, 1));
    // One time constant: 63 % of rated speed.
    expect(simulation.outputs("m").actualSpeed).toBeCloseTo(1450 * (1 - Math.exp(-1)), 0);
    events.push(...run(simulation, 10));
    expect(simulation.outputs("m")).toMatchObject({ actualSpeed: 1450, running: true });
    // No load on the shaft: no-load current only.
    expect(simulation.outputs("m").current).toBeCloseTo(3.5, 6);

    simulation.setInputs("m", { run: false });
    events.push(...run(simulation, 30));
    expect(simulation.outputs("m")).toMatchObject({ actualSpeed: 0, running: false, current: 0 });
    expect(events.map((event) => event.payload.to)).toEqual(["RUNNING", "COASTING", "STOPPED"]);
    expect(events.every((event) => event.type === "MOTOR_STATE_CHANGED")).toBe(true);
  });

  it("trips on overload even while its drive keeps running, and needs a reset", () => {
    const simulation = simulate(chain("1"));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    run(simulation, 8);
    simulation.injectFault("motor1", "OVERLOAD");
    run(simulation, 20);
    expect(simulation.outputs("motor1")).toMatchObject({ faulted: true, running: false, actualSpeed: 0 });
    expect(simulation.outputs("vfd1").actualFrequency).toBe(50);
    expect(simulation.outputs("pump1")).toMatchObject({ running: false, flow: 0 });

    simulation.clearFault("motor1", "OVERLOAD");
    simulation.reset("motor1");
    run(simulation, 5);
    expect(simulation.outputs("motor1")).toMatchObject({ faulted: false, actualSpeed: 1450 });
  });
});

describe("pump and other motor-driven equipment", () => {
  it("produces flow proportional to speed and pressure proportional to speed squared", () => {
    const simulation = simulate(chain("1", { pump: { ratedFlow: 120, ratedPressure: 6 } }));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 25 });
    const events = run(simulation, 10);
    expect(simulation.outputs("pump1").flow).toBeCloseTo(60, 1);
    expect(simulation.outputs("pump1").pressure).toBeCloseTo(1.5, 2);
    expect(simulation.outputs("pt1").value).toBeCloseTo(1.5, 2);
    expect(events).toContainEqual(
      expect.objectContaining({ type: "PUMP_STATE_CHANGED", payload: expect.objectContaining({ to: "RUNNING" }) }),
    );
  });

  it("loses flow and pressure when running dry and unloads the motor", () => {
    const simulation = simulate(chain("1"));
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    run(simulation, 8);
    expect(simulation.injectFault("pump1", "DRY_RUN")).toMatchObject({ severity: "WARNING" });
    simulation.step(TICK);
    expect(simulation.outputs("pump1")).toMatchObject({ flow: 0, pressure: 0, running: true, faulted: true });
    expect(simulation.outputs("motor1").current).toBeCloseTo(3.5 + 6.5 * 0.2, 6);

    // Not latching: clearing the cause restores the pump without a reset.
    simulation.clearFault("pump1", "DRY_RUN");
    simulation.step(TICK);
    expect(simulation.outputs("pump1")).toMatchObject({ flow: 100, pressure: 4, faulted: false });
  });

  it("stays still when no motor drives it", () => {
    const simulation = simulate([{ id: "p", name: "P-01", type: "PUMP" }]);
    run(simulation, 5);
    expect(simulation.outputs("p")).toMatchObject({ running: false, flow: 0, pressure: 0 });
  });

  it("models a conveyor as a constant-torque load and a fan as a quadratic one", () => {
    const simulation = simulate([
      { id: "m1", name: "M-01", type: "MOTOR" },
      { id: "belt", name: "CV-01", type: "CONVEYOR", motorId: "m1", params: { ratedOutput: 2 } },
      { id: "m2", name: "M-02", type: "MOTOR" },
      { id: "fan", name: "FN-01", type: "FAN", motorId: "m2" },
    ]);
    simulation.setInputs("m1", { run: true });
    simulation.setInputs("m2", { run: true });
    const events = run(simulation, 10);
    expect(simulation.outputs("belt")).toMatchObject({ running: true, output: 2 });
    expect(simulation.outputs("fan")).toMatchObject({ running: true, output: 100 });
    expect(simulation.outputs("m1").current).toBeCloseTo(10, 6);
    expect(events).toContainEqual(expect.objectContaining({ type: "DEVICE_STATE_CHANGED", deviceId: "belt" }));
  });
});

describe("independent chains in one simulation", () => {
  it("runs several VFD → motor → pump chains without one affecting another", () => {
    const simulation = simulate([...chain("1"), ...chain("2"), ...chain("3", { vfd: { accelTimeS: 1 } })]);
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    simulation.setInputs("vfd3", { run: true, frequencySetpoint: 10 });
    run(simulation, 2);
    expect(simulation.outputs("vfd1").actualFrequency).toBeCloseTo(20, 6);
    expect(simulation.outputs("vfd2").actualFrequency).toBe(0);
    expect(simulation.outputs("vfd3").actualFrequency).toBe(10);

    simulation.injectFault("vfd1", "OVERCURRENT");
    run(simulation, 10);
    expect(simulation.outputs("pump1").running).toBe(false);
    expect(simulation.outputs("pump2").running).toBe(false);
    expect(simulation.outputs("pump3")).toMatchObject({ running: true, faulted: false });
    expect(simulation.outputs("pt3").value).toBeCloseTo(4 * 0.2 * 0.2, 3);
    expect(simulation.snapshot()).toHaveLength(12);
  });

  it("is deterministic: the same inputs produce the same states", () => {
    const build = () => {
      const simulation = simulate([
        ...chain("1"),
        {
          id: "noise",
          name: "TT-01",
          type: "SENSOR",
          params: { source: { kind: "RANDOM", min: 10, max: 20, seed: 7 } },
        },
      ]);
      simulation.setInputs("vfd1", { run: true, frequencySetpoint: 37.5 });
      run(simulation, 7.3);
      return simulation.snapshot();
    };
    expect(build()).toEqual(build());
  });
});

describe("valve", () => {
  const valve = (params?: unknown): DeviceConfig[] => [{ id: "v", name: "XV-01", type: "VALVE", params }];

  it("travels at its stroke time and reports its limit switches", () => {
    const simulation = simulate(valve({ travelTimeS: 4 }));
    expect(simulation.outputs("v")).toMatchObject({ position: 0, closed: true, opened: false });

    simulation.setInputs("v", { open: true });
    const events = run(simulation, 2);
    expect(simulation.outputs("v").position).toBeCloseTo(50, 6);
    expect(simulation.outputs("v")).toMatchObject({ closed: false, opened: false });
    run(simulation, 2.5).forEach((event) => events.push(event));
    expect(simulation.outputs("v")).toMatchObject({ position: 100, opened: true });

    // Single-acting: without the open command it returns to closed.
    simulation.setInputs("v", { open: false });
    run(simulation, 5).forEach((event) => events.push(event));
    expect(simulation.outputs("v")).toMatchObject({ position: 0, closed: true });
    expect(events.map((event) => event.payload.to)).toEqual(["OPENING", "OPEN", "CLOSING", "CLOSED"]);
    expect(events.every((event) => event.type === "VALVE_STATE_CHANGED")).toBe(true);
  });

  it("holds its position when double-acting and neither command is present", () => {
    const simulation = simulate(valve({ travelTimeS: 10 }));
    simulation.setInputs("v", { open: true, close: false });
    run(simulation, 3);
    simulation.setInputs("v", { open: false, close: false });
    run(simulation, 3);
    expect(simulation.outputs("v").position).toBeCloseTo(30, 6);
    simulation.setInputs("v", { open: false, close: true });
    run(simulation, 4);
    expect(simulation.outputs("v")).toMatchObject({ position: 0, closed: true });
  });

  it("follows an analog position setpoint", () => {
    const simulation = simulate(valve({ travelTimeS: 10, initialPosition: 100 }));
    simulation.setInputs("v", { positionSetpoint: 35 });
    run(simulation, 20);
    expect(simulation.outputs("v")).toMatchObject({ position: 35, opened: false, closed: false });
    simulation.setInputs("v", { positionSetpoint: 250 });
    run(simulation, 20);
    expect(simulation.outputs("v").position).toBe(100);
  });

  it("does not move while stuck and does not report the fault itself", () => {
    const simulation = simulate(valve({ travelTimeS: 4 }));
    simulation.injectFault("v", "STUCK");
    simulation.setInputs("v", { open: true });
    run(simulation, 10);
    expect(simulation.outputs("v")).toMatchObject({ position: 0, closed: true, faulted: false });
    expect(simulation.snapshot()[0]).toMatchObject({ faulted: true, activeFaults: ["STUCK"] });

    simulation.clearFault("v", "STUCK");
    run(simulation, 5);
    expect(simulation.outputs("v").opened).toBe(true);
  });
});

describe("sensor", () => {
  const sensor = (params: unknown, extra: DeviceConfig[] = []): DeviceConfig[] => [
    ...extra,
    { id: "s", name: "TT-01", type: "SENSOR", params, measuresId: extra[0]?.id },
  ];

  it("generates constant, ramp and sine profiles", () => {
    const constant = simulate(sensor({ source: { kind: "CONSTANT", value: 21.5 } }));
    run(constant, 3);
    expect(constant.outputs("s").value).toBe(21.5);

    const ramp = simulate(sensor({ source: { kind: "RAMP", from: 0, to: 100, periodS: 10 } }));
    run(ramp, 2.5);
    expect(ramp.outputs("s").value).toBeCloseTo(25, 6);
    run(ramp, 10);
    expect(ramp.outputs("s").value).toBeCloseTo(25, 6);

    const sine = simulate(sensor({ source: { kind: "SINE", min: 10, max: 30, periodS: 8 } }));
    run(sine, 2);
    expect(sine.outputs("s").value).toBeCloseTo(30, 6);
    run(sine, 4);
    expect(sine.outputs("s").value).toBeCloseTo(10, 6);
  });

  it("draws reproducible random samples inside its limits", () => {
    const params = { source: { kind: "RANDOM", min: 5, max: 6, intervalS: 0.5, seed: 42 } };
    const first = simulate(sensor(params));
    const second = simulate(sensor(params));
    const values = new Set<number>();
    for (let step = 0; step < 100; step += 1) {
      first.step(TICK);
      second.step(TICK);
      const value = first.outputs("s").value as number;
      expect(value).toBe(second.outputs("s").value);
      expect(value).toBeGreaterThanOrEqual(5);
      expect(value).toBeLessThan(6);
      values.add(value);
    }
    expect(values.size).toBeGreaterThan(10);
  });

  it("follows a measured signal with gain, offset, lag and range limits", () => {
    const simulation = simulate(
      sensor(
        {
          source: { kind: "MEASURED", signal: "position", gain: 0.16, offset: 4 },
          timeConstantS: 1,
          rangeMin: 4,
          rangeMax: 12,
        },
        [{ id: "v", name: "XV-01", type: "VALVE", params: { initialPosition: 100, travelTimeS: 1 } }],
      ),
    );
    simulation.setInputs("v", { positionSetpoint: 100 });
    // The source asks for 20; the sensor lags towards it and stops at its range limit of 12.
    run(simulation, 0.3);
    expect(simulation.outputs("s").value).toBeGreaterThan(4);
    expect(simulation.outputs("s").value).toBeLessThan(12);
    run(simulation, 20);
    expect(simulation.outputs("s").value).toBe(12);
  });

  it("emits a value event only when the value moves by the deadband", () => {
    const simulation = simulate(sensor({ source: { kind: "RAMP", from: 0, to: 100, periodS: 100 }, eventDeadband: 5 }));
    // 1 unit per second: crossings near 5, 10, 15 and 20.
    const events = run(simulation, 22);
    expect(events).toHaveLength(4);
    expect(events.every((event) => event.type === "SENSOR_VALUE_CHANGED")).toBe(true);
  });

  it("reads bottom of range with bad quality on signal loss, and freezes when stuck", () => {
    const simulation = simulate(
      sensor({ source: { kind: "RAMP", from: 4, to: 20, periodS: 16 }, rangeMin: 4, rangeMax: 20 }),
    );
    run(simulation, 4);
    expect(simulation.outputs("s").value).toBeCloseTo(8, 6);

    simulation.injectFault("s", "BAD_QUALITY");
    const events = simulation.step(TICK);
    expect(simulation.outputs("s")).toMatchObject({ value: 4, faulted: true });
    expect(simulation.snapshot()[0]).toMatchObject({ quality: "BAD", state: "BAD" });
    expect(events).toContainEqual(expect.objectContaining({ type: "SENSOR_VALUE_CHANGED" }));
    simulation.clearFault("s", "BAD_QUALITY");
    simulation.step(TICK);
    expect(simulation.outputs("s")).toMatchObject({ faulted: false });
    expect(simulation.outputs("s").value).toBeCloseTo(8.2, 6);

    simulation.injectFault("s", "STUCK");
    run(simulation, 3);
    expect(simulation.outputs("s").value).toBeCloseTo(8.2, 6);
    expect(simulation.outputs("s").faulted).toBe(false);
  });

  it("can be forced to a value and released", () => {
    const simulation = simulate(sensor({ source: { kind: "CONSTANT", value: 2 } }));
    expect(simulation.setOverride("s", 9.5).type).toBe("SIMULATED_INPUT_FORCED");
    simulation.step(TICK);
    expect(simulation.outputs("s").value).toBe(9.5);
    expect(simulation.setOverride("s", null).type).toBe("SIMULATED_INPUT_RELEASED");
    simulation.step(TICK);
    expect(simulation.outputs("s").value).toBe(2);
    expectDomainError(() => simulation.setOverride("s", true), "INCOMPATIBLE", "forcible-device");
  });

  it("rejects a measured source without a device, an unknown signal and invalid parameters", () => {
    expectDomainError(
      () => simulate(sensor({ source: { kind: "MEASURED", signal: "pressure" } })),
      "VALIDATION",
      "measured-device",
    );
    expectDomainError(
      () =>
        simulate(
          sensor({ source: { kind: "MEASURED", signal: "pressure" } }, [{ id: "v", name: "XV-01", type: "VALVE" }]),
        ),
      "VALIDATION",
      "measured-signal",
    );
    expectDomainError(
      () => simulate(sensor({ source: { kind: "CONSTANT", value: 1 }, rangeMin: 10, rangeMax: 5 })),
      "VALIDATION",
      "simulation-params",
    );
    expectDomainError(() => simulate(sensor({ unknownOption: true })), "VALIDATION", "simulation-params");
  });
});

describe("switch", () => {
  it("holds a constant state and can be operated by hand", () => {
    const simulation = simulate([{ id: "sw", name: "HS-01", type: "SWITCH" }]);
    expect(simulation.outputs("sw").state).toBe(false);
    simulation.setOverride("sw", true);
    const events = simulation.step(TICK);
    expect(simulation.outputs("sw").state).toBe(true);
    expect(events).toEqual([
      expect.objectContaining({
        type: "DEVICE_STATE_CHANGED",
        payload: expect.objectContaining({ from: "OFF", to: "ON" }),
      }),
    ]);
    expectDomainError(() => simulation.setOverride("sw", 3), "INCOMPATIBLE", "forcible-device");
  });

  it("switches on a measured value with hysteresis", () => {
    const simulation = simulate([
      ...chain("1"),
      {
        id: "ps",
        name: "PS-01",
        type: "SWITCH",
        measuresId: "pump1",
        params: { source: { kind: "MEASURED", signal: "pressure", onAbove: 3, offBelow: 1 } },
      },
    ]);
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 50 });
    run(simulation, 8);
    expect(simulation.outputs("ps").state).toBe(true);

    // 30 Hz → 1.44 bar: between the two thresholds, so the switch keeps its state.
    simulation.setInputs("vfd1", { run: true, frequencySetpoint: 30 });
    run(simulation, 8);
    expect(simulation.outputs("ps").state).toBe(true);

    simulation.setInputs("vfd1", { run: false });
    run(simulation, 15);
    expect(simulation.outputs("ps").state).toBe(false);
  });

  it("keeps its state while stuck", () => {
    const simulation = simulate([{ id: "sw", name: "LS-01", type: "SWITCH" }]);
    simulation.injectFault("sw", "STUCK");
    simulation.setOverride("sw", true);
    run(simulation, 1);
    expect(simulation.outputs("sw").state).toBe(false);
  });
});

describe("catalog fault overrides and input validation", () => {
  it("lets a catalog model change severity and latching of a generic fault", () => {
    const simulation = simulate([
      { id: "v", name: "XV-01", type: "VALVE", faults: { STUCK: { severity: "CRITICAL", latching: true } } },
    ]);
    expect(simulation.injectFault("v", "STUCK")).toMatchObject({ severity: "CRITICAL", payload: { latching: true } });
    simulation.step(TICK);
    simulation.clearFault("v", "STUCK");
    simulation.setInputs("v", { open: true });
    run(simulation, 10);
    // Tripped: still frozen after the cause is gone.
    expect(simulation.outputs("v")).toMatchObject({ position: 0, faulted: true });
    simulation.reset("v");
    run(simulation, 10);
    expect(simulation.outputs("v").opened).toBe(true);
  });

  it("rejects unknown devices, duplicate devices and negative steps", () => {
    const simulation = simulate(chain("1"));
    expect(() => simulation.setInputs("missing", {})).toThrow(DomainError);
    expectDomainError(() => simulation.step(-1), "VALIDATION", "step");
    expectDomainError(
      () => simulate([...chain("1"), { id: "vfd1", name: "again", type: "VFD" }]),
      "INVARIANT",
      "unique-device",
    );
  });
});
