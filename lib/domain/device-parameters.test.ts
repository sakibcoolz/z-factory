import { describe, expect, it } from "vitest";
import { parameterFieldsFor, parameterValues } from "./device-parameters";

describe("device parameters", () => {
  it("describes the numeric parameters of the behaviour models, with limits and generic defaults", () => {
    expect(parameterFieldsFor("VFD").map((field) => [field.key, field.unit, field.max, field.defaultValue])).toEqual([
      ["maxFrequencyHz", "Hz", 1000, 50],
      ["accelTimeS", "s", 3600, 5],
      ["decelTimeS", "s", 3600, 5],
    ]);
    expect(parameterFieldsFor("VALVE").find((field) => field.key === "initialPosition")).toMatchObject({
      min: 0,
      max: 100,
      minInclusive: true,
      unit: "%",
    });
    expect(parameterFieldsFor("PUMP").map((field) => field.key)).toEqual(["ratedFlow", "ratedPressure"]);
    expect(parameterFieldsFor("FAN").map((field) => field.key)).toEqual(["ratedOutput"]);
    expect(parameterFieldsFor("MOTOR")).toHaveLength(6);
  });

  it("has no parameters for sensors, switches and unsimulated types", () => {
    for (const type of ["SENSOR", "SWITCH", "NONE", "RELAY"]) expect(parameterFieldsFor(type)).toEqual([]);
  });

  it("shows stored values and falls back to the default for what is missing or not a number", () => {
    const fields = parameterFieldsFor("VFD");
    expect(parameterValues(fields, null)).toEqual({ maxFrequencyHz: 50, accelTimeS: 5, decelTimeS: 5 });
    expect(parameterValues(fields, { maxFrequencyHz: 60, accelTimeS: "fast", other: 1 })).toEqual({
      maxFrequencyHz: 60,
      accelTimeS: 5,
      decelTimeS: 5,
    });
  });
});
