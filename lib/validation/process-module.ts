/**
 * Zod schemas for process-module input at the application boundary. What a module may
 * contain beyond its shape is decided by its type (lib/domain/process-module.ts).
 */
import { z } from "zod";
import { INTERLOCK_OPERATORS, MODULE_KEY_PATTERN } from "@/lib/domain/process-module";
import { deviceNameSchema } from "./schemas";

const key = z.string().regex(MODULE_KEY_PATTERN, "Use capitals, digits and underscores, e.g. HIGH_PRESSURE_STOP.");
const location = z.string().trim().max(120);
const config = z.record(z.string(), z.unknown());

/** Module names follow device names: PUMP-HOUSE-01, TANK-2. Unique within the factory. */
export const moduleInputSchema = z.strictObject({
  factoryId: z.uuid(),
  typeId: z.uuid(),
  name: deviceNameSchema,
  location: location.optional(),
  /** One of the type's profiles; its first when left out. */
  profile: key.optional(),
  /** Settings the type declares; the rest take their defaults. */
  config: config.default({}),
});

/** Only what is given changes. A given `config` replaces the stored one. */
export const moduleUpdateSchema = z.strictObject({
  name: deviceNameSchema.optional(),
  location: location.nullable().optional(),
  profile: key.optional(),
  config: config.optional(),
});

export const moduleAssignmentInputSchema = z.strictObject({
  roleKey: key,
  deviceId: z.uuid(),
});

const interlockConditionSchema = z.strictObject({
  signal: key,
  operator: z.enum(INTERLOCK_OPERATORS),
  value: z.number().finite().optional(),
});

export const interlockExpressionSchema = z.strictObject({
  when: z.array(interlockConditionSchema).min(1).max(8),
  blocks: z.array(key).min(1).max(16),
});

export const moduleInterlockInputSchema = z.strictObject({
  code: key,
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).optional(),
  severity: z.enum(["INFO", "WARNING", "CRITICAL"]).default("WARNING"),
  enabled: z.boolean().default(true),
  expression: interlockExpressionSchema,
});

export const moduleInterlockUpdateSchema = moduleInterlockInputSchema.omit({ code: true }).partial();

/** Binding one module signal to one PLC tag (TASK-605). */
export const moduleBindingInputSchema = z.strictObject({
  signalKey: key,
  tagId: z.uuid(),
});

/** The bindings of a module as exported, reconstructed by PLC and tag names. */
export const moduleIoImportSchema = z.strictObject({
  schema: z.literal("z-factory.module-io"),
  schemaVersion: z.literal(1),
  generatedAt: z.string().optional(),
  module: z
    .object({ name: z.string(), type: z.string(), version: z.number().int(), profile: z.string().nullable() })
    .partial({ name: true })
    .loose(),
  bindings: z
    .array(z.object({ signal: key, plc: z.string().trim().min(1), tag: z.string().trim().min(1) }).loose())
    .max(256),
});
