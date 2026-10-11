// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEVICE_PROFILES } from "@/lib/domain/process-sim";
import { DEVICE_FAULTS, DEVICE_SIGNALS, SIMULATED_TYPES } from "@/lib/domain/simulation";
import { paramsSchemaFor } from "@/lib/runtimes/device-sim/params";
import { parameterFieldsFor } from "./device-parameters";
import {
  BEHAVIOR_PROFILES,
  type BehaviorParameter,
  checkParameterValue,
  coverageStatement,
  findBehaviorProfile,
  profileCommands,
  profileFeedback,
  wireParameter,
} from "./behavior-contract";

const profiles = Object.values(BEHAVIOR_PROFILES);

describe("the behaviour contract", () => {
  it("describes every simulated type once, under its own key and version 1", () => {
    expect(Object.keys(BEHAVIOR_PROFILES).sort()).toEqual([...SIMULATED_TYPES].sort());
    for (const profile of profiles) {
      expect(profile.key).toBe(profile.simulatorType);
      expect(profile.version).toBe(1);
      expect(profile.summary.length).toBeGreaterThan(40);
      expect(profile.states.length).toBeGreaterThan(1);
      expect(profile.fidelity.approximations.length).toBeGreaterThan(0);
      expect(profile.fidelity.notModelled.length).toBeGreaterThan(0);
      expect(profile.protocol).toBe("NONE");
    }
    expect(findBehaviorProfile("BOILER")).toBeUndefined();
    expect(findBehaviorProfile("VFD")?.key).toBe("VFD");
  });

  it("carries the signals and faults of the simulation vocabulary, commands apart from feedback", () => {
    for (const profile of profiles) {
      expect(profile.signals.map(({ range: _range, ...signal }) => signal)).toEqual(
        DEVICE_SIGNALS[profile.simulatorType].map((signal) => ({ ...signal })),
      );
      expect(profileCommands(profile).every((signal) => signal.direction === "IN")).toBe(true);
      expect(profileFeedback(profile).every((signal) => signal.direction === "OUT")).toBe(true);
      expect(profile.faults.map(({ reset: _reset, effect: _effect, quality: _quality, ...fault }) => fault)).toEqual(
        DEVICE_FAULTS[profile.simulatorType].map((fault) => ({ ...fault })),
      );
      for (const fault of profile.faults) {
        // A latching fault trips the device and needs a reset; the others end with their cause.
        expect(fault.reset).toBe(fault.latching ? "RESET_SIGNAL_OR_OPERATOR" : "AUTO");
        expect(fault.effect.length).toBeGreaterThan(5);
        expect(fault.quality === "BAD").toBe(profile.badQualityOnFaults.includes(fault.code));
      }
      // A range bound by a parameter names one of the profile's parameters.
      for (const signal of profile.signals) {
        for (const named of [signal.range?.minParameter, signal.range?.maxParameter]) {
          if (named) expect(profile.parameters.map((parameter) => parameter.key)).toContain(named);
        }
      }
    }
    expect(BEHAVIOR_PROFILES.SENSOR.faults.find((fault) => fault.code === "BAD_QUALITY")?.quality).toBe("BAD");
    expect(BEHAVIOR_PROFILES.VALVE.faults.find((fault) => fault.code === "STUCK")?.reset).toBe("AUTO");
  });

  it("names the relationships its links are made from, and whether they are required", () => {
    expect(BEHAVIOR_PROFILES.MOTOR.links).toEqual([
      expect.objectContaining({ role: "drive", required: false, accepts: ["VFD"], relationship: "DRIVES" }),
    ]);
    for (const type of ["PUMP", "FAN", "CONVEYOR", "MIXER", "COMPRESSOR"] as const) {
      expect(BEHAVIOR_PROFILES[type].links).toEqual([
        expect.objectContaining({
          role: "motor",
          required: true,
          relationship: "MECHANICALLY_DRIVES",
          peerIs: "SOURCE",
        }),
      ]);
    }
    for (const type of ["SENSOR", "SWITCH"] as const) {
      expect(BEHAVIOR_PROFILES[type].links).toEqual([
        expect.objectContaining({ role: "measures", required: false, accepts: null, relationship: "MEASURES" }),
      ]);
      expect(BEHAVIOR_PROFILES[type].forcible).toBe(true);
    }
    expect(BEHAVIOR_PROFILES.VFD.links).toEqual([]);
    expect(BEHAVIOR_PROFILES.VFD.forcible).toBe(false);
  });

  it("keeps every default inside its own bounds, and agrees with the server simulator's parameter schemas", () => {
    for (const profile of profiles) {
      const keys = profile.parameters.map((parameter) => parameter.key);
      expect(new Set(keys).size).toBe(keys.length);
      const defaults: Record<string, unknown> = {};
      for (const parameter of profile.parameters) {
        if (parameter.kind === "NUMBER" && parameter.default === null) continue;
        expect(checkParameterValue(parameter, parameter.default), `${profile.key}.${parameter.key}`).toBeNull();
        defaults[parameter.key] = parameter.default;
      }
      // The zod schema of the server's simulator fills the same defaults.
      const parsed = paramsSchemaFor(profile.simulatorType).parse({}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) continue;
        expect(defaults[key], `${profile.key}.${key}`).toEqual(value);
      }
      // What the zod schema leaves to the behaviour (the load profile of a load) the contract states.
      for (const [key, value] of Object.entries(defaults)) {
        if (parsed[key] !== undefined) expect(parsed[key], `${profile.key}.${key}`).toEqual(value);
        else expect(["loadProfile"]).toContain(key);
      }
      // A value outside the bounds is refused by both.
      for (const parameter of profile.parameters) {
        if (parameter.kind !== "NUMBER" || parameter.max === null) continue;
        const outside = parameter.max + 1;
        expect(checkParameterValue(parameter, outside)).toMatch(/at most|less than/);
        expect(paramsSchemaFor(profile.simulatorType).safeParse({ [parameter.key]: outside }).success).toBe(false);
      }
    }
  });

  it("checks a value against a parameter's kind and bounds, and says why it is refused", () => {
    const accel = BEHAVIOR_PROFILES.VFD.parameters.find((parameter) => parameter.key === "accelTimeS")!;
    expect(checkParameterValue(accel, 0)).toBe("must be greater than 0");
    expect(checkParameterValue(accel, 3600)).toBeNull();
    expect(checkParameterValue(accel, 3601)).toBe("must be at most 3600");
    expect(checkParameterValue(accel, "5")).toBe("must be a finite number");
    expect(checkParameterValue(accel, Number.NaN)).toBe("must be a finite number");
    const ratio = BEHAVIOR_PROFILES.MOTOR.parameters.find((parameter) => parameter.key === "noLoadCurrentRatio")!;
    expect(checkParameterValue(ratio, 0)).toBeNull();
    expect(checkParameterValue(ratio, -0.1)).toBe("must be at least 0");
    const shape = BEHAVIOR_PROFILES.FAN.parameters.find((parameter) => parameter.key === "loadProfile")!;
    expect(checkParameterValue(shape, "CONSTANT")).toBeNull();
    expect(checkParameterValue(shape, "LINEAR")).toBe("must be one of QUADRATIC, CONSTANT");
    const source = BEHAVIOR_PROFILES.SENSOR.parameters.find((parameter) => parameter.key === "source")!;
    expect(checkParameterValue(source, { kind: "SINE", min: 0, max: 10, periodS: 5 })).toBeNull();
    expect(checkParameterValue(source, { kind: "NOISE" })).toMatch(/kind must be one of CONSTANT, RAMP/);
    expect(checkParameterValue(source, { kind: "CONSTANT", state: true })).toBe("has no field state for kind CONSTANT");
    expect(checkParameterValue(source, 3)).toBe("must be an object");
  });

  it("is what the device parameter forms and the runtime's profile map are built from", () => {
    for (const profile of profiles) {
      expect(DEVICE_PROFILES[profile.simulatorType]).toEqual({ profile: profile.key, profileVersion: 1 });
      const fields = parameterFieldsFor(profile.simulatorType);
      if (profile.forcible) {
        expect(fields).toEqual([]);
        continue;
      }
      const numbers = profile.parameters.filter(
        (parameter): parameter is BehaviorParameter & { kind: "NUMBER" } => parameter.kind === "NUMBER",
      );
      expect(fields.map((field) => field.key)).toEqual(numbers.map((parameter) => parameter.key));
      for (const field of fields) {
        const parameter = numbers.find((candidate) => candidate.key === field.key)!;
        expect(field).toMatchObject({
          unit: parameter.unit,
          min: parameter.min,
          max: parameter.max,
          minInclusive: parameter.minInclusive,
          defaultValue: parameter.default,
        });
      }
    }
  });

  it("travels over the wire without nulls or false flags", () => {
    expect(wireParameter(BEHAVIOR_PROFILES.VFD.parameters[0]!)).toEqual({
      key: "maxFrequencyHz",
      label: "Maximum output frequency",
      kind: "NUMBER",
      role: "RATING",
      unit: "Hz",
      default: 50,
      min: 0,
      max: 1000,
      maxInclusive: true,
    });
    expect(
      wireParameter(BEHAVIOR_PROFILES.SENSOR.parameters.find((parameter) => parameter.key === "rangeMax")!),
    ).toEqual({ key: "rangeMax", label: "Range maximum", kind: "NUMBER", role: "LIMIT" });
    expect(wireParameter(BEHAVIOR_PROFILES.FAN.parameters[1]!)).toMatchObject({
      kind: "CHOICE",
      default: "QUADRATIC",
      choices: ["QUADRATIC", "CONSTANT"],
    });
    expect(wireParameter(BEHAVIOR_PROFILES.SWITCH.parameters[0]!)).toMatchObject({
      kind: "STRUCTURED",
      default: { kind: "CONSTANT", state: false },
      kinds: { CONSTANT: ["state"], MEASURED: ["signal", "onAbove", "offBelow"] },
    });
  });

  it("says in words that coverage is a behaviour model, never vendor firmware", () => {
    const vfd = { key: "VFD", version: 1 };
    expect(coverageStatement("GENERIC", vfd)).toBe(
      "the generic behaviour of its category (behaviour profile VFD v1): a behaviour model, not vendor firmware",
    );
    expect(coverageStatement("FULL", vfd)).toContain("not vendor firmware");
    expect(coverageStatement("PARTIAL", vfd)).toContain("a declared subset");
    expect(coverageStatement("NOT_SIMULATABLE", null)).toBe(
      "configuration and metadata only; the simulator executes no behaviour for it",
    );
  });
});
