import "server-only";
import { z } from "zod";
import { DomainError } from "@/lib/domain/errors";
import { isLoadType, type SimulatedType } from "@/lib/domain/simulation";

/**
 * Behaviour parameters of the simulated device types.
 *
 * Every default is a generic value for a generic simulated device. None is a vendor
 * specification; a catalog model or instance overrides them through its SimulationProfile.
 */

const finite = z.number().finite();
const positive = finite.positive();
const seconds = positive.max(3600);

export const vfdParamsSchema = z.strictObject({
  maxFrequencyHz: positive.max(1000).default(50),
  /** Time to ramp from zero to the maximum frequency. */
  accelTimeS: seconds.default(5),
  /** Time to ramp from the maximum frequency to zero. */
  decelTimeS: seconds.default(5),
});
export type VfdParams = z.infer<typeof vfdParamsSchema>;

export const motorParamsSchema = z.strictObject({
  ratedSpeedRpm: positive.default(1450),
  ratedFrequencyHz: positive.default(50),
  ratedCurrentA: positive.default(10),
  /** Share of the rated current drawn with no load on the shaft. */
  noLoadCurrentRatio: finite.min(0).max(1).default(0.35),
  /** First-order response of the speed to a change of supply. */
  timeConstantS: seconds.default(0.5),
  /** First-order coast-down once the supply is gone. */
  coastTimeConstantS: seconds.default(2),
});
export type MotorParams = z.infer<typeof motorParamsSchema>;

export const pumpParamsSchema = z.strictObject({
  /** Flow at rated speed, in the engineering unit of the tag it is mapped to. */
  ratedFlow: positive.default(100),
  /** Discharge pressure at rated speed. */
  ratedPressure: positive.default(4),
});
export type PumpParams = z.infer<typeof pumpParamsSchema>;

export const loadParamsSchema = z.strictObject({
  /** Output at rated speed (airflow, belt speed, …). */
  ratedOutput: positive.default(100),
  /** How shaft torque grows with speed. Defaults to QUADRATIC for fans, CONSTANT otherwise. */
  loadProfile: z.enum(["QUADRATIC", "CONSTANT"]).optional(),
});
export type LoadParams = z.infer<typeof loadParamsSchema>;

export const valveParamsSchema = z.strictObject({
  /** Time for a full stroke. */
  travelTimeS: seconds.default(5),
  initialPosition: finite.min(0).max(100).default(0),
});
export type ValveParams = z.infer<typeof valveParamsSchema>;

const sensorSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("CONSTANT"), value: finite.default(0) }),
  /** Sawtooth from `from` to `to`, repeating every period. */
  z.strictObject({ kind: z.literal("RAMP"), from: finite, to: finite, periodS: seconds }),
  z.strictObject({ kind: z.literal("SINE"), min: finite, max: finite, periodS: seconds }),
  /** A new uniformly distributed sample every interval, from a seeded generator. */
  z.strictObject({
    kind: z.literal("RANDOM"),
    min: finite,
    max: finite,
    intervalS: seconds.default(1),
    seed: z.number().int().default(1),
  }),
  /** Follows an output signal of the device this sensor measures: value = signal × gain + offset. */
  z.strictObject({
    kind: z.literal("MEASURED"),
    signal: z.string().min(1).max(64),
    gain: finite.default(1),
    offset: finite.default(0),
  }),
]);

export const sensorParamsSchema = z
  .strictObject({
    source: sensorSourceSchema.default({ kind: "CONSTANT", value: 0 }),
    rangeMin: finite.optional(),
    rangeMax: finite.optional(),
    /** First-order response time of the sensor; 0 follows the source immediately. */
    timeConstantS: finite.min(0).max(3600).default(0),
    initialValue: finite.optional(),
    /** A SENSOR_VALUE_CHANGED event is emitted when the value moves by at least this much. */
    eventDeadband: positive.optional(),
  })
  .refine(
    (params) => params.rangeMin === undefined || params.rangeMax === undefined || params.rangeMin < params.rangeMax,
    "rangeMin must be below rangeMax",
  );
export type SensorParams = z.infer<typeof sensorParamsSchema>;

const switchSourceSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("CONSTANT"), state: z.boolean().default(false) }),
  /** Closes at or above `onAbove`, opens at or below `offBelow` (defaults to `onAbove`). */
  z.strictObject({
    kind: z.literal("MEASURED"),
    signal: z.string().min(1).max(64),
    onAbove: finite,
    offBelow: finite.optional(),
  }),
]);

export const switchParamsSchema = z.strictObject({
  source: switchSourceSchema.default({ kind: "CONSTANT", state: false }),
});
export type SwitchParams = z.infer<typeof switchParamsSchema>;

export function paramsSchemaFor(type: SimulatedType) {
  switch (type) {
    case "VFD":
      return vfdParamsSchema;
    case "MOTOR":
      return motorParamsSchema;
    case "PUMP":
      return pumpParamsSchema;
    case "VALVE":
      return valveParamsSchema;
    case "SENSOR":
      return sensorParamsSchema;
    case "SWITCH":
      return switchParamsSchema;
    default:
      if (isLoadType(type)) return loadParamsSchema;
      throw new DomainError("INCOMPATIBLE", `Device type ${type} is not simulated.`, { rule: "simulated-type" });
  }
}

/** Validates raw profile parameters for a device type; missing values take the generic defaults. */
export function parseParams<T>(schema: z.ZodType<T>, raw: unknown, deviceName: string): T {
  const result = schema.safeParse(raw ?? {});
  if (!result.success) {
    throw new DomainError("VALIDATION", `The simulation parameters of ${deviceName} are not valid.`, {
      rule: "simulation-params",
      device: deviceName,
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  return result.data;
}
