// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEVICE_PROFILES } from "@/lib/domain/process-sim";
import { DEVICE_FAULTS, DEVICE_SIGNALS, isSimulatedType, SIMULATED_TYPES } from "@/lib/domain/simulation";
import { paramsSchemaFor } from "@/lib/runtimes/device-sim/params";
import { parameterFieldsFor } from "./device-parameters";
import {
  BEHAVIOR_PROFILES,
  type BehaviorParameter,
  type BehaviorProfile,
  checkParameterValue,
  coverageStatement,
  findBehaviorProfile,
  profileCommands,
  profileFeedback,
  wireParameter,
} from "./behavior-contract";

const profiles = Object.values(BEHAVIOR_PROFILES);
/** The ten profiles the server's own simulator runs. */
const ported = profiles.filter((profile) => profile.runsOn.server);
/** The behaviour library of TASK-1011: runtime-only profiles. */
const library = profiles.filter((profile) => !profile.runsOn.server);

const profile = (key: string): BehaviorProfile => {
  const found = findBehaviorProfile(key);
  if (!found) throw new Error(`no profile ${key}`);
  return found;
};
const parameter = (key: string, name: string): BehaviorParameter => {
  const found = profile(key).parameters.find((candidate) => candidate.key === name);
  if (!found) throw new Error(`no parameter ${key}.${name}`);
  return found;
};

describe("the behaviour contract", () => {
  it("describes every profile once, under its own key and version 1, and says where it runs", () => {
    expect(ported.map((item) => item.key).sort()).toEqual([...SIMULATED_TYPES].sort());
    expect(library.map((item) => item.key).sort()).toEqual(["HEATER", "INDICATOR", "RELAY"]);
    for (const item of profiles) {
      expect(item.key).toBe(item.simulatorType);
      expect(BEHAVIOR_PROFILES[item.key]).toBe(item);
      expect(item.version).toBe(1);
      expect(item.runsOn.runtime).toBe(true);
      expect(item.runsOn.server).toBe(isSimulatedType(item.key));
      expect(item.summary.length).toBeGreaterThan(40);
      expect(item.states.length).toBeGreaterThan(1);
      expect(item.signals.length).toBeGreaterThan(0);
      expect(item.fidelity.approximations.length).toBeGreaterThan(0);
      expect(item.fidelity.notModelled.length).toBeGreaterThan(0);
      expect(item.protocol).toBe("NONE");
      const keys = item.signals.map((signal) => signal.key);
      expect(new Set(keys).size).toBe(keys.length);
    }
    expect(findBehaviorProfile("BOILER")).toBeUndefined();
    expect(findBehaviorProfile("toString")).toBeUndefined();
    expect(findBehaviorProfile("VFD")?.key).toBe("VFD");
  });

  it("carries the signals and faults of the simulation vocabulary for the ported profiles", () => {
    for (const item of ported) {
      if (!isSimulatedType(item.simulatorType)) throw new Error(item.key);
      expect(item.signals.map(({ range: _range, ...signal }) => signal)).toEqual(
        DEVICE_SIGNALS[item.simulatorType].map((signal) => ({ ...signal })),
      );
      expect(item.faults.map(({ reset: _reset, effect: _effect, quality: _quality, ...fault }) => fault)).toEqual(
        DEVICE_FAULTS[item.simulatorType].map((fault) => ({ ...fault })),
      );
    }
  });

  it("keeps commands apart from feedback and derives the reset rule and quality of every fault", () => {
    for (const item of profiles) {
      expect(profileCommands(item).every((signal) => signal.direction === "IN")).toBe(true);
      expect(profileFeedback(item).every((signal) => signal.direction === "OUT")).toBe(true);
      expect(profileFeedback(item).length).toBeGreaterThan(0);
      for (const fault of item.faults) {
        // A latching fault trips the device and needs a reset; the others end with their cause.
        expect(fault.reset).toBe(fault.latching ? "RESET_SIGNAL_OR_OPERATOR" : "AUTO");
        expect(fault.effect.length).toBeGreaterThan(5);
        expect(fault.quality === "BAD").toBe(item.badQualityOnFaults.includes(fault.code));
        // A fault the device reports needs a fault output; a silent one needs none.
        if (!fault.silent)
          expect(
            item.signals.some((signal) => signal.key === "faulted"),
            item.key,
          ).toBe(true);
      }
      // A range bound by a parameter names one of the profile's parameters.
      for (const signal of item.signals) {
        for (const named of [signal.range?.minParameter, signal.range?.maxParameter]) {
          if (named) expect(item.parameters.map((candidate) => candidate.key)).toContain(named);
        }
      }
    }
    expect(profile("SENSOR").faults.find((fault) => fault.code === "BAD_QUALITY")?.quality).toBe("BAD");
    expect(profile("VALVE").faults.find((fault) => fault.code === "STUCK")?.reset).toBe("AUTO");
    expect(profile("HEATER").faults.find((fault) => fault.code === "OVERTEMPERATURE")?.reset).toBe(
      "RESET_SIGNAL_OR_OPERATOR",
    );
    expect(profile("RELAY").faults.every((fault) => fault.silent)).toBe(true);
  });

  it("names the relationships its links are made from, and whether they are required", () => {
    expect(profile("MOTOR").links).toEqual([
      expect.objectContaining({ role: "drive", required: false, accepts: ["VFD", "RELAY"], relationship: "DRIVES" }),
    ]);
    for (const type of ["PUMP", "FAN", "CONVEYOR", "MIXER", "COMPRESSOR"]) {
      expect(profile(type).links).toEqual([
        expect.objectContaining({
          role: "motor",
          required: true,
          relationship: "MECHANICALLY_DRIVES",
          peerIs: "SOURCE",
        }),
      ]);
    }
    for (const type of ["SENSOR", "SWITCH"]) {
      expect(profile(type).links).toEqual([
        expect.objectContaining({ role: "measures", required: false, accepts: null, relationship: "MEASURES" }),
      ]);
      expect(profile(type).forcible).toBe(true);
    }
    expect(profile("HEATER").links).toEqual([
      expect.objectContaining({ role: "contactor", required: false, accepts: ["RELAY"], relationship: "CONTROLS" }),
    ]);
    // A link accepts profiles that exist.
    for (const item of profiles) {
      for (const link of item.links) {
        for (const accepted of link.accepts ?? []) expect(findBehaviorProfile(accepted), accepted).toBeDefined();
      }
    }
    expect(profile("VFD").links).toEqual([]);
    expect(profile("VFD").forcible).toBe(false);
  });

  it("keeps every default inside its own bounds, and agrees with the server simulator's parameter schemas", () => {
    for (const item of profiles) {
      const keys = item.parameters.map((candidate) => candidate.key);
      expect(new Set(keys).size).toBe(keys.length);
      const defaults: Record<string, unknown> = {};
      for (const candidate of item.parameters) {
        if (candidate.kind === "NUMBER" && candidate.default === null) continue;
        expect(checkParameterValue(candidate, candidate.default), `${item.key}.${candidate.key}`).toBeNull();
        defaults[candidate.key] = candidate.default;
      }
      if (!isSimulatedType(item.simulatorType)) continue;
      // The zod schema of the server's simulator fills the same defaults.
      const parsed = paramsSchemaFor(item.simulatorType).parse({}) as Record<string, unknown>;
      for (const [key, value] of Object.entries(parsed)) {
        if (value === undefined) continue;
        expect(defaults[key], `${item.key}.${key}`).toEqual(value);
      }
      // What the zod schema leaves to the behaviour (the load profile of a load) the contract states.
      for (const [key, value] of Object.entries(defaults)) {
        if (parsed[key] !== undefined) expect(parsed[key], `${item.key}.${key}`).toEqual(value);
        else expect(["loadProfile"]).toContain(key);
      }
      // A value outside the bounds is refused by both.
      for (const candidate of item.parameters) {
        if (candidate.kind !== "NUMBER" || candidate.max === null) continue;
        const outside = candidate.max + 1;
        expect(checkParameterValue(candidate, outside)).toMatch(/at most|less than/);
        expect(paramsSchemaFor(item.simulatorType).safeParse({ [candidate.key]: outside }).success).toBe(false);
      }
    }
  });

  it("checks a value against a parameter's kind and bounds, and says why it is refused", () => {
    const accel = parameter("VFD", "accelTimeS");
    expect(checkParameterValue(accel, 0)).toBe("must be greater than 0");
    expect(checkParameterValue(accel, 3600)).toBeNull();
    expect(checkParameterValue(accel, 3601)).toBe("must be at most 3600");
    expect(checkParameterValue(accel, "5")).toBe("must be a finite number");
    expect(checkParameterValue(accel, Number.NaN)).toBe("must be a finite number");
    const ratio = parameter("MOTOR", "noLoadCurrentRatio");
    expect(checkParameterValue(ratio, 0)).toBeNull();
    expect(checkParameterValue(ratio, -0.1)).toBe("must be at least 0");
    const shape = parameter("FAN", "loadProfile");
    expect(checkParameterValue(shape, "CONSTANT")).toBeNull();
    expect(checkParameterValue(shape, "LINEAR")).toBe("must be one of QUADRATIC, CONSTANT");
    const source = parameter("SENSOR", "source");
    expect(checkParameterValue(source, { kind: "SINE", min: 0, max: 10, periodS: 5 })).toBeNull();
    expect(checkParameterValue(source, { kind: "NOISE" })).toMatch(/kind must be one of CONSTANT, RAMP/);
    expect(checkParameterValue(source, { kind: "CONSTANT", state: true })).toBe("has no field state for kind CONSTANT");
    expect(checkParameterValue(source, 3)).toBe("must be an object");
    const pickup = parameter("RELAY", "pickupTimeS");
    expect(checkParameterValue(pickup, 0)).toBeNull();
    expect(checkParameterValue(pickup, 10.5)).toBe("must be at most 10");
  });

  it("is what the device parameter forms and the runtime's profile map are built from", () => {
    for (const item of profiles) {
      expect(DEVICE_PROFILES[item.simulatorType]).toEqual({ profile: item.key, profileVersion: 1 });
      const fields = parameterFieldsFor(item.simulatorType);
      if (item.forcible) {
        expect(fields).toEqual([]);
        continue;
      }
      const numbers = item.parameters.filter(
        (candidate): candidate is BehaviorParameter & { kind: "NUMBER" } =>
          candidate.kind === "NUMBER" && candidate.default !== null,
      );
      expect(fields.map((field) => field.key)).toEqual(numbers.map((candidate) => candidate.key));
      for (const field of fields) {
        const candidate = numbers.find((number) => number.key === field.key);
        expect(field).toMatchObject({
          unit: candidate?.unit,
          min: candidate?.min,
          max: candidate?.max,
          minInclusive: candidate?.minInclusive,
          defaultValue: candidate?.default,
        });
      }
    }
    expect(parameterFieldsFor("NONE")).toEqual([]);
  });

  it("travels over the wire without nulls or false flags", () => {
    expect(wireParameter(parameter("VFD", "maxFrequencyHz"))).toEqual({
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
    expect(wireParameter(parameter("SENSOR", "rangeMax"))).toEqual({
      key: "rangeMax",
      label: "Range maximum",
      kind: "NUMBER",
      role: "LIMIT",
    });
    expect(wireParameter(parameter("FAN", "loadProfile"))).toMatchObject({
      kind: "CHOICE",
      default: "QUADRATIC",
      choices: ["QUADRATIC", "CONSTANT"],
    });
    expect(wireParameter(parameter("SWITCH", "source"))).toMatchObject({
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
