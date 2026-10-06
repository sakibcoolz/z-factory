import { z } from "zod";
import { longestRunS, SCENARIO_COMPARISONS, SCENARIO_LIMITS, type Scenario } from "@/lib/domain/scenario";

const name = z.string().trim().min(1).max(120);
const seconds = z.number().finite().positive().max(SCENARIO_LIMITS.stepS);
const number = z.number().finite();

const stepSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("WRITE"), plc: name, tag: name, value: z.union([number, z.boolean()]) }),
  z.strictObject({ kind: z.literal("FORCE"), device: name, value: z.union([number, z.boolean()]) }),
  z.strictObject({ kind: z.literal("OVERRIDE"), module: name, signal: name, value: number }),
  z.strictObject({
    kind: z.literal("RAMP"),
    module: name,
    signal: name,
    from: number,
    to: number,
    durationS: seconds,
  }),
  z.strictObject({ kind: z.literal("CLEAR") }),
  z.strictObject({
    kind: z.literal("EXPECT"),
    plc: name,
    tag: name,
    op: z.enum(SCENARIO_COMPARISONS),
    value: z.union([number, z.boolean()]),
    tolerance: z.number().finite().min(0).optional(),
    withinS: seconds.default(10),
    holdS: seconds.optional(),
  }),
  z.strictObject({ kind: z.literal("WAIT"), seconds }),
]);

/** A scenario as stored or pasted: bounded in steps and in the longest time it can take. */
export const scenarioSchema: z.ZodType<Scenario, unknown> = z
  .strictObject({
    name,
    description: z.string().trim().max(2000).optional(),
    steps: z.array(stepSchema).min(1).max(SCENARIO_LIMITS.steps),
  })
  .refine((scenario) => longestRunS(scenario.steps) <= SCENARIO_LIMITS.totalS, {
    message: `a scenario may take at most ${SCENARIO_LIMITS.totalS} s, counting every wait and EXPECT at its limit`,
    path: ["steps"],
  });
