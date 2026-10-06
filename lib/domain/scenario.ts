/**
 * Closed-loop test scenarios (Phase 08, TASK-804, docs/process-simulation.md → Scenarios).
 * A scenario is a repeatable test of PLC logic against simulated equipment: it asks for
 * what an operator may ask for (command and setpoint tags), changes what the simulation
 * feeds the PLC (a forced sensor or switch, an overridden process value), and checks
 * what the PLC program does about it by reading its tags. It never writes what the
 * program decides: an alarm or an output is expected, never set (ADR-0015).
 *
 * Steps name things as an engineer does (PLC, tag, device, module and signal by name), so
 * one scenario runs against any factory built the same way. Pure types and rules.
 */

export const SCENARIO_COMPARISONS = ["EQ", "NE", "GT", "GTE", "LT", "LTE"] as const;
export type ScenarioComparison = (typeof SCENARIO_COMPARISONS)[number];

export type ScenarioStep =
  /** Writes a command or setpoint tag, as an operator or a gateway would. */
  | { kind: "WRITE"; plc: string; tag: string; value: number | boolean }
  /** Forces the value of a simulated sensor (a number) or switch (true/false). */
  | { kind: "FORCE"; device: string; value: number | boolean }
  /** Puts a measured value of a process module into MANUAL_OVERRIDE. */
  | { kind: "OVERRIDE"; module: string; signal: string; value: number }
  /** Puts a measured value of a process module on a ramp over simulated time (SCENARIO). */
  | { kind: "RAMP"; module: string; signal: string; from: number; to: number; durationS: number }
  /** Returns every forced and overridden value of the factory to AUTO. */
  | { kind: "CLEAR" }
  /**
   * Waits until a PLC tag satisfies the comparison, at most `withinS` seconds. With
   * `holdS` the condition must then hold that long without a break.
   */
  | {
      kind: "EXPECT";
      plc: string;
      tag: string;
      op: ScenarioComparison;
      value: number | boolean;
      /** Allowed difference for EQ/NE on numbers. */
      tolerance?: number;
      withinS: number;
      holdS?: number;
    }
  | { kind: "WAIT"; seconds: number };

export type ScenarioStepKind = ScenarioStep["kind"];

export type Scenario = { name: string; description?: string; steps: ScenarioStep[] };

/** Limits that keep a run bounded: a scenario is a test, not a schedule. */
export const SCENARIO_LIMITS = { steps: 100, stepS: 300, totalS: 900 } as const;

export type ScenarioStatus = "PASSED" | "FAILED";

export type ScenarioStepResult = {
  index: number;
  kind: ScenarioStepKind;
  label: string;
  status: "PASSED" | "FAILED" | "SKIPPED";
  /** Seconds since the run started, when the step finished. */
  atS: number | null;
  /** The last value read, for EXPECT. */
  observed?: number | boolean | null;
  message?: string;
};

/** A value the run took out of AUTO, as the evidence names it. */
export type ScenarioOverride = {
  target: string;
  mode: "FORCED" | "MANUAL_OVERRIDE" | "SCENARIO";
  value?: number | boolean;
  profile?: { from: number; to: number; durationS: number };
  atS: number;
};

export type ScenarioReport = {
  runId: string;
  name: string;
  status: ScenarioStatus;
  startedAt: string;
  finishedAt: string;
  durationS: number;
  steps: ScenarioStepResult[];
  /** Every value the run forced or overrode; all of them are back in AUTO when it ends. */
  overrides: ScenarioOverride[];
  /** Why the run failed: the first failed step, or what stopped it. */
  failure: string | null;
};

const format = (value: number | boolean) => (typeof value === "boolean" ? (value ? "ON" : "OFF") : String(value));
const OPERATOR: Record<ScenarioComparison, string> = { EQ: "=", NE: "≠", GT: ">", GTE: "≥", LT: "<", LTE: "≤" };

/** One line that says what a step does. */
export function stepLabel(step: ScenarioStep): string {
  switch (step.kind) {
    case "WRITE":
      return `write ${step.plc} · ${step.tag} = ${format(step.value)}`;
    case "FORCE":
      return `force ${step.device} = ${format(step.value)}`;
    case "OVERRIDE":
      return `override ${step.module} · ${step.signal} = ${step.value}`;
    case "RAMP":
      return `ramp ${step.module} · ${step.signal} ${step.from} → ${step.to} in ${step.durationS} s`;
    case "CLEAR":
      return "clear every override (back to AUTO)";
    case "EXPECT": {
      const tolerance = step.tolerance ? ` ± ${step.tolerance}` : "";
      const hold = step.holdS ? `, held ${step.holdS} s` : "";
      return `expect ${step.plc} · ${step.tag} ${OPERATOR[step.op]} ${format(step.value)}${tolerance} within ${step.withinS} s${hold}`;
    }
    case "WAIT":
      return `wait ${step.seconds} s`;
  }
}

/** Whether a value read from a tag satisfies an EXPECT step. A missing value never does. */
export function satisfies(
  observed: number | boolean | null | undefined,
  step: Pick<Extract<ScenarioStep, { kind: "EXPECT" }>, "op" | "value" | "tolerance">,
): boolean {
  if (observed === null || observed === undefined) return false;
  if (typeof step.value === "boolean" || typeof observed === "boolean") {
    const same = Boolean(observed) === Boolean(step.value);
    if (step.op === "EQ") return same;
    if (step.op === "NE") return !same;
    return false;
  }
  const tolerance = step.tolerance ?? 0;
  switch (step.op) {
    case "EQ":
      return Math.abs(observed - step.value) <= tolerance;
    case "NE":
      return Math.abs(observed - step.value) > tolerance;
    case "GT":
      return observed > step.value;
    case "GTE":
      return observed >= step.value;
    case "LT":
      return observed < step.value;
    case "LTE":
      return observed <= step.value;
  }
}

/** The longest a scenario can take: every wait and every EXPECT at its limit. */
export function longestRunS(steps: readonly ScenarioStep[]): number {
  return steps.reduce((total, step) => {
    if (step.kind === "WAIT") return total + step.seconds;
    if (step.kind === "EXPECT") return total + step.withinS + (step.holdS ?? 0);
    return total;
  }, 0);
}

/** What the scenario screen's run action returns: the report, or why the run did not start. */
export type ScenarioRunState = { report?: ScenarioReport; message?: string; source?: string };

/**
 * A first scenario for a factory, to edit before running: asks for a command and expects
 * a value the program drives. Names the factory's own PLC and tags when it has them.
 */
export function exampleScenario(names: { plc?: string; command?: string; expected?: string }): Scenario {
  const plc = names.plc ?? "PLC-01";
  return {
    name: "Start and check",
    description: "Ask for a start as an operator does, then check what the program does about it.",
    steps: [
      { kind: "WRITE", plc, tag: names.command ?? "Start_Cmd", value: true },
      { kind: "EXPECT", plc, tag: names.expected ?? "Run_Output", op: "EQ", value: true, withinS: 5 },
      { kind: "WRITE", plc, tag: names.command ?? "Start_Cmd", value: false },
      { kind: "EXPECT", plc, tag: names.expected ?? "Run_Output", op: "EQ", value: false, withinS: 5 },
    ],
  };
}
