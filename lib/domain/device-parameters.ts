/**
 * The parameters a configurable device shows and stores (TASK-308). They are the
 * numeric parameters of the device's behaviour model (`lib/runtimes/device-sim/params.ts`),
 * described for a form. Every default is a generic value, never a vendor specification.
 * Pure; importable anywhere.
 */
import { isLoadType } from "@/lib/domain/simulation";

export type ParameterField = {
  key: string;
  label: string;
  unit: string | null;
  min: number | null;
  max: number | null;
  /** Whether the lower limit itself is allowed. */
  minInclusive: boolean;
  defaultValue: number;
  description: string | null;
};

const field = (
  key: string,
  label: string,
  defaultValue: number,
  options: Partial<Omit<ParameterField, "key" | "label" | "defaultValue">> = {},
): ParameterField => ({
  key,
  label,
  defaultValue,
  unit: options.unit ?? null,
  min: options.min ?? 0,
  max: options.max ?? null,
  minInclusive: options.minInclusive ?? false,
  description: options.description ?? null,
});

const seconds = (key: string, label: string, defaultValue: number, description?: string) =>
  field(key, label, defaultValue, { unit: "s", max: 3600, description: description ?? null });

const VFD_FIELDS: ParameterField[] = [
  field("maxFrequencyHz", "Maximum output frequency", 50, { unit: "Hz", max: 1000 }),
  seconds("accelTimeS", "Acceleration time", 5, "Time to ramp from zero to the maximum frequency."),
  seconds("decelTimeS", "Deceleration time", 5, "Time to ramp from the maximum frequency to zero."),
];

const MOTOR_FIELDS: ParameterField[] = [
  field("ratedSpeedRpm", "Rated speed", 1450, { unit: "rpm" }),
  field("ratedFrequencyHz", "Rated frequency", 50, { unit: "Hz" }),
  field("ratedCurrentA", "Rated current", 10, { unit: "A" }),
  field("noLoadCurrentRatio", "No-load current ratio", 0.35, {
    min: 0,
    max: 1,
    minInclusive: true,
    description: "Share of the rated current drawn with no load on the shaft.",
  }),
  seconds("timeConstantS", "Speed time constant", 0.5),
  seconds("coastTimeConstantS", "Coast-down time constant", 2),
];

const PUMP_FIELDS: ParameterField[] = [
  field("ratedFlow", "Rated flow", 100, {
    description: "Flow at rated speed, in the unit of the tag it is mapped to.",
  }),
  field("ratedPressure", "Rated discharge pressure", 4),
];

const LOAD_FIELDS: ParameterField[] = [
  field("ratedOutput", "Rated output", 100, { description: "Output at rated speed: airflow, belt speed, …" }),
];

const VALVE_FIELDS: ParameterField[] = [
  seconds("travelTimeS", "Travel time", 5, "Time for a full stroke."),
  field("initialPosition", "Initial position", 0, { unit: "%", min: 0, max: 100, minInclusive: true }),
];

/**
 * The editable parameters of a behaviour model. Sensors and switches are driven by a
 * signal source, not by numbers of their own, and have none here.
 */
export function parameterFieldsFor(simulatorType: string): ParameterField[] {
  switch (simulatorType) {
    case "VFD":
      return VFD_FIELDS;
    case "MOTOR":
      return MOTOR_FIELDS;
    case "PUMP":
      return PUMP_FIELDS;
    case "VALVE":
      return VALVE_FIELDS;
    default:
      return isLoadType(simulatorType) ? LOAD_FIELDS : [];
  }
}

/** The stored values a form shows: what was saved, else the generic default. */
export function parameterValues(
  fields: readonly ParameterField[],
  stored: Readonly<Record<string, unknown>> | null,
): Record<string, number> {
  return Object.fromEntries(
    fields.map((item) => {
      const value = stored?.[item.key];
      return [item.key, typeof value === "number" && Number.isFinite(value) ? value : item.defaultValue];
    }),
  );
}
