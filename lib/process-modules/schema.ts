/**
 * Shape and rules of process-module type definitions (docs/process-modules.md).
 *
 * A definition is data. `parseModuleType` checks it before anything is written to the
 * database, so a template with an unknown device category, a signal on a missing role or
 * an output that is not a command fails loudly instead of becoming a module type.
 */
import { z } from "zod";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { DomainError } from "@/lib/domain/errors";
import {
  checkModuleType,
  MODULE_CONFIG_FIELD_TYPES,
  MODULE_KEY_PATTERN,
  MODULE_SIGNAL_DIRECTIONS,
  type ModuleTypeDefinition,
} from "@/lib/domain/process-module";
import { TAG_DATA_TYPES, TAG_ROLES } from "@/lib/domain/tag";

const key = z.string().regex(MODULE_KEY_PATTERN, "use capitals, digits and underscores, e.g. SPEED_SETPOINT");
const text = z.string().trim().min(1).max(120);
const description = z.string().trim().min(1).max(500).nullable().default(null);
const unit = z.string().trim().min(1).max(16).nullable().default(null);
const profiles = z.array(key).max(16).default([]);
const limit = z.number().finite().nullable().default(null);

const CATEGORY_CODES = new Set(GENERIC_CATEGORIES.map((category) => category.code));

const roleSchema = z.strictObject({
  key,
  name: text,
  description,
  deviceCategoryCodes: z
    .array(z.string().refine((code) => CATEGORY_CODES.has(code), "is not a device category"))
    .max(16)
    .default([]),
  required: z.boolean().default(true),
  maxDevices: z.number().int().min(1).max(64).default(1),
  profiles,
});

const signalSchema = z.strictObject({
  key,
  name: text,
  description,
  direction: z.enum(MODULE_SIGNAL_DIRECTIONS),
  dataType: z.enum(TAG_DATA_TYPES),
  role: z.enum(TAG_ROLES),
  unit,
  signalType: z.string().trim().min(1).max(40).nullable().default(null),
  required: z.boolean().default(true),
  rangeMin: limit,
  rangeMax: limit,
  roleKey: key.nullable().default(null),
  profiles,
});

const configFieldSchema = z.strictObject({
  key: z.string().regex(/^[a-z][A-Za-z0-9]{0,63}$/, "use a key such as ratedFlow"),
  label: text,
  type: z.enum(MODULE_CONFIG_FIELD_TYPES),
  unit,
  min: limit,
  max: limit,
  options: z.array(z.string().trim().min(1).max(40)).max(32).default([]),
  defaultValue: z
    .union([z.number().finite(), z.boolean(), z.string().max(200)])
    .nullable()
    .default(null),
});

export const moduleTypeSchema = z.strictObject({
  code: key,
  name: text,
  version: z.number().int().min(1).default(1),
  description,
  simulatorModelType: z.string().trim().min(1).max(64).nullable().default(null),
  profiles,
  configFields: z.array(configFieldSchema).max(64).default([]),
  roles: z.array(roleSchema).max(64).default([]),
  signals: z.array(signalSchema).min(1).max(256),
});

export type ModuleTypeInput = z.input<typeof moduleTypeSchema>;

/** A checked definition. Throws a VALIDATION error naming the first thing that is wrong. */
export function parseModuleType(input: unknown): ModuleTypeDefinition {
  const result = moduleTypeSchema.safeParse(input);
  if (!result.success) {
    const issues = result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new DomainError("VALIDATION", `Invalid module type: ${issues[0]}.`, { issues });
  }
  const issues = checkModuleType(result.data);
  if (issues.length > 0) {
    throw new DomainError("VALIDATION", `Invalid module type ${result.data.code}: ${issues[0]}.`, { issues });
  }
  return result.data;
}

const storedConfigSchema = z.object({ fields: z.array(configFieldSchema).default([]) });

/** The configuration fields of a stored type, read back from its `configSchemaJson`. */
export function parseConfigFields(json: unknown): ModuleTypeDefinition["configFields"] {
  const result = storedConfigSchema.safeParse(json);
  return result.success ? result.data.fields : [];
}
