import { describe, expect, it } from "vitest";
import { exampleScenario, longestRunS, satisfies, type ScenarioStep, stepLabel } from "@/lib/domain/scenario";
import { parseInput } from "@/lib/validation/parse";
import { scenarioSchema } from "@/lib/validation/scenario";

const expectStep = (op: "EQ" | "NE" | "GT" | "GTE" | "LT" | "LTE", value: number | boolean, tolerance?: number) => ({
  op,
  value,
  tolerance,
});

describe("closed-loop scenarios (TASK-804)", () => {
  it("compares what a tag reads with what a step expects", () => {
    expect(satisfies(true, expectStep("EQ", true))).toBe(true);
    expect(satisfies(false, expectStep("EQ", true))).toBe(false);
    expect(satisfies(false, expectStep("NE", true))).toBe(true);
    // An on/off tag has no order.
    expect(satisfies(true, expectStep("GT", false))).toBe(false);
    expect(satisfies(2.98, expectStep("EQ", 3, 0.05))).toBe(true);
    expect(satisfies(2.9, expectStep("EQ", 3, 0.05))).toBe(false);
    expect(satisfies(2.9, expectStep("NE", 3, 0.05))).toBe(true);
    expect(satisfies(3.01, expectStep("GT", 3))).toBe(true);
    expect(satisfies(3, expectStep("GTE", 3))).toBe(true);
    expect(satisfies(3, expectStep("LT", 3))).toBe(false);
    expect(satisfies(3, expectStep("LTE", 3))).toBe(true);
    // A tag that could not be read never satisfies anything.
    expect(satisfies(null, expectStep("NE", 1))).toBe(false);
  });

  it("says what each step does", () => {
    const steps: ScenarioStep[] = [
      { kind: "WRITE", plc: "PLC-01", tag: "Start_Cmd", value: true },
      { kind: "FORCE", device: "TT-01", value: 92.5 },
      { kind: "OVERRIDE", module: "PH-01", signal: "DISCHARGE_PRESSURE", value: 3.5 },
      { kind: "RAMP", module: "PH-01", signal: "DISCHARGE_PRESSURE", from: 1, to: 4, durationS: 10 },
      { kind: "CLEAR" },
      { kind: "EXPECT", plc: "PLC-01", tag: "Temp", op: "GTE", value: 80, tolerance: 0.5, withinS: 5, holdS: 2 },
      { kind: "WAIT", seconds: 1.5 },
    ];
    expect(steps.map(stepLabel)).toEqual([
      "write PLC-01 · Start_Cmd = ON",
      "force TT-01 = 92.5",
      "override PH-01 · DISCHARGE_PRESSURE = 3.5",
      "ramp PH-01 · DISCHARGE_PRESSURE 1 → 4 in 10 s",
      "clear every override (back to AUTO)",
      "expect PLC-01 · Temp ≥ 80 ± 0.5 within 5 s, held 2 s",
      "wait 1.5 s",
    ]);
    expect(longestRunS(steps)).toBe(8.5);
  });

  it("accepts a bounded scenario and refuses anything else", () => {
    const parsed = parseInput(scenarioSchema, {
      name: " High temperature ",
      steps: [{ kind: "EXPECT", plc: "PLC-01", tag: "Alarm", op: "EQ", value: false }],
    });
    // A name is trimmed, an EXPECT waits 10 s unless told otherwise.
    expect(parsed).toEqual({
      name: "High temperature",
      steps: [{ kind: "EXPECT", plc: "PLC-01", tag: "Alarm", op: "EQ", value: false, withinS: 10 }],
    });
    expect(parseInput(scenarioSchema, exampleScenario({}))).toMatchObject({ name: "Start and check" });

    const refused = (input: unknown) => {
      try {
        parseInput(scenarioSchema, input);
        return "accepted";
      } catch (error) {
        return (error as Error).message;
      }
    };
    expect(refused({ name: "x", steps: [] })).toMatch(/steps/);
    expect(refused({ name: "x", steps: [{ kind: "SET_OUTPUT", plc: "PLC-01", tag: "Run", value: true }] })).toMatch(
      /kind/,
    );
    expect(refused({ name: "x", steps: [{ kind: "WAIT", seconds: 0 }] })).toMatch(/seconds/);
    expect(refused({ name: "x", steps: [{ kind: "WAIT", seconds: 301 }] })).toMatch(/seconds/);
    expect(refused({ name: "x", steps: [{ kind: "CLEAR", extra: 1 }] })).not.toBe("accepted");
    // Every wait and EXPECT counted at its limit: four 300 s waits are more than 900 s.
    expect(refused({ name: "x", steps: Array.from({ length: 4 }, () => ({ kind: "WAIT", seconds: 300 })) })).toMatch(
      /at most 900 s/,
    );
  });
});
