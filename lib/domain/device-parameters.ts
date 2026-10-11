/**
 * The parameters a configurable device shows and stores (TASK-308). They are the numeric
 * parameters of the device's behaviour profile (`lib/domain/behavior-contract.ts`), as a
 * form shows them. Every default is a generic value, never a vendor specification.
 * Pure; importable anywhere.
 */
import { type BehaviorProfile, findBehaviorProfile, type NumberParameter } from "@/lib/domain/behavior-contract";

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

const toField = (parameter: NumberParameter & { default: number }): ParameterField => ({
  key: parameter.key,
  label: parameter.label,
  unit: parameter.unit,
  min: parameter.min,
  max: parameter.max,
  minInclusive: parameter.minInclusive,
  defaultValue: parameter.default,
  description: parameter.description,
});

/** Profiles whose numbers are set on the Parameters form. */
const hasForm = (profile: BehaviorProfile) => !profile.forcible;

/**
 * The editable parameters of a behaviour profile: its numeric parameters with a generic
 * default. Sensors and switches are driven by a signal source, not by numbers of their
 * own; their source is configured with the simulation profile, so they have none here.
 */
export function parameterFieldsFor(simulatorType: string): ParameterField[] {
  const profile = findBehaviorProfile(simulatorType);
  if (!profile || !hasForm(profile)) return [];
  return profile.parameters
    .filter((parameter): parameter is NumberParameter & { default: number } => {
      return parameter.kind === "NUMBER" && parameter.default !== null;
    })
    .map(toField);
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
