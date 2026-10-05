/**
 * Process modules (docs/process-modules.md): a module type is a reusable template with
 * the roles devices play in it and its logical I/O contract; a module instance is one
 * use of a type in a factory. Pure rules; importable anywhere.
 *
 * A signal here is logical. It reserves no PLC endpoint; binding signals to tags and
 * I/O points is the module I/O registry (TASK-605).
 */
import { DomainError } from "@/lib/domain/errors";
import { isWritableTagRole, type TagDataType, type TagRole } from "@/lib/domain/tag";

/** Direction of a module signal, seen from the PLC program. */
export const MODULE_SIGNAL_DIRECTIONS = ["INPUT", "OUTPUT", "INTERNAL", "ALARM"] as const;

export type ModuleSignalDirection = (typeof MODULE_SIGNAL_DIRECTIONS)[number];

/** Stable keys of types, profiles, roles, signals and interlocks, e.g. `SPEED_SETPOINT`. */
export const MODULE_KEY_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;

/** A role a factory device plays in a module: process meaning, separate from what the device is. */
export type ModuleRole = {
  key: string;
  name: string;
  description: string | null;
  /** Device categories that can fill the role; empty accepts any. */
  deviceCategoryCodes: string[];
  /** A module without a device in a required role is incomplete. */
  required: boolean;
  maxDevices: number;
  /** Profiles the role applies to; empty means all. */
  profiles: string[];
};

/** One logical signal of a module type. */
export type ModuleSignal = {
  key: string;
  name: string;
  description: string | null;
  direction: ModuleSignalDirection;
  dataType: TagDataType;
  role: TagRole;
  unit: string | null;
  /** Expected electrical signal or protocol class, when the template names one. */
  signalType: string | null;
  required: boolean;
  rangeMin: number | null;
  rangeMax: number | null;
  /** The role whose device carries the signal, when it belongs to one. */
  roleKey: string | null;
  /** Profiles the signal applies to; empty means all. */
  profiles: string[];
};

export const MODULE_CONFIG_FIELD_TYPES = ["number", "integer", "boolean", "text", "choice"] as const;

export type ModuleConfigValue = number | boolean | string;

/** One setting an instance of the type may carry in its configuration. */
export type ModuleConfigField = {
  /** Key in the instance's configuration, e.g. `tankVolume`. */
  key: string;
  label: string;
  type: (typeof MODULE_CONFIG_FIELD_TYPES)[number];
  unit: string | null;
  min: number | null;
  max: number | null;
  /** The values a `choice` may take. */
  options: string[];
  /** Used when the instance does not set the field. A field without one has to be set. */
  defaultValue: ModuleConfigValue | null;
};

export type ModuleTypeDefinition = {
  code: string;
  name: string;
  version: number;
  description: string | null;
  /** The process model that simulates the type; null until one exists (TASK-602). */
  simulatorModelType: string | null;
  /** Selectable variants; roles and signals may apply to some of them only. */
  profiles: string[];
  configFields: ModuleConfigField[];
  roles: ModuleRole[];
  signals: ModuleSignal[];
};

/**
 * Which semantic roles a signal of a direction may have. An OUTPUT is what the PLC
 * writes, so it is a command or a setpoint and nothing else is; the PLC stays the only
 * source of commands (ADR-0006).
 */
export function signalRoleFits(direction: ModuleSignalDirection, role: TagRole): boolean {
  if (direction === "OUTPUT") return isWritableTagRole(role);
  if (direction === "ALARM") return role === "ALARM" || role === "STATUS";
  return !isWritableTagRole(role);
}

/** True when a role or signal exists in the profile; one that names no profile exists in all. */
export function appliesToProfile(item: { profiles: readonly string[] }, profile: string | null): boolean {
  return item.profiles.length === 0 || (profile !== null && item.profiles.includes(profile));
}

export function effectiveRoles<Role extends { profiles: readonly string[] }>(
  roles: readonly Role[],
  profile: string | null,
): Role[] {
  return roles.filter((role) => appliesToProfile(role, profile));
}

export function effectiveSignals<Signal extends { profiles: readonly string[] }>(
  signals: readonly Signal[],
  profile: string | null,
): Signal[] {
  return signals.filter((signal) => appliesToProfile(signal, profile));
}

export type SignalCounts = Record<ModuleSignalDirection, { required: number; optional: number }>;

/** How many signals a module has per direction: the I/O count is the profile's, not the type's. */
export function countSignals(
  signals: ReadonlyArray<{ direction: ModuleSignalDirection; required: boolean }>,
): SignalCounts {
  const counts = Object.fromEntries(
    MODULE_SIGNAL_DIRECTIONS.map((direction) => [direction, { required: 0, optional: 0 }]),
  ) as SignalCounts;
  for (const signal of signals) counts[signal.direction][signal.required ? "required" : "optional"] += 1;
  return counts;
}

function duplicates(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const twice = new Set<string>();
  for (const value of values) (seen.has(value) ? twice : seen).add(value);
  return [...twice];
}

function checkConfigValue(field: ModuleConfigField, value: unknown): string | null {
  switch (field.type) {
    case "boolean":
      return typeof value === "boolean" ? null : "must be true or false";
    case "text":
      return typeof value === "string" && value.length <= 200 ? null : "must be text of at most 200 characters";
    case "choice":
      return typeof value === "string" && field.options.includes(value)
        ? null
        : `must be one of ${field.options.join(", ")}`;
    default: {
      if (typeof value !== "number" || !Number.isFinite(value)) return "must be a number";
      if (field.type === "integer" && !Number.isInteger(value)) return "must be a whole number";
      if (field.min !== null && value < field.min) return `must be at least ${field.min}`;
      if (field.max !== null && value > field.max) return `must be at most ${field.max}`;
      return null;
    }
  }
}

/**
 * What is wrong with a module type definition, beyond the shape of its fields. An empty
 * list means the definition can be stored.
 */
export function checkModuleType(type: ModuleTypeDefinition): string[] {
  const issues: string[] = [];
  const profiles = new Set(type.profiles);
  const unknownProfiles = (item: { profiles: readonly string[] }) =>
    item.profiles.filter((profile) => !profiles.has(profile));

  for (const profile of duplicates(type.profiles)) issues.push(`profile ${profile} is listed twice`);
  for (const key of duplicates(type.roles.map((role) => role.key))) issues.push(`role ${key} is defined twice`);
  for (const key of duplicates(type.signals.map((signal) => signal.key))) {
    issues.push(`signal ${key} is defined twice`);
  }
  for (const key of duplicates(type.configFields.map((field) => field.key))) {
    issues.push(`configuration field ${key} is defined twice`);
  }

  const roles = new Map(type.roles.map((role) => [role.key, role]));
  for (const role of type.roles) {
    for (const profile of unknownProfiles(role)) issues.push(`role ${role.key} names unknown profile ${profile}`);
    if (role.maxDevices < 1) issues.push(`role ${role.key} must allow at least one device`);
  }

  for (const signal of type.signals) {
    for (const profile of unknownProfiles(signal)) issues.push(`signal ${signal.key} names unknown profile ${profile}`);
    if (!signalRoleFits(signal.direction, signal.role)) {
      issues.push(`signal ${signal.key}: a ${signal.direction} signal cannot have the role ${signal.role}`);
    }
    if (signal.rangeMin !== null && signal.rangeMax !== null && signal.rangeMin >= signal.rangeMax) {
      issues.push(`signal ${signal.key}: the range must run from a lower to a higher value`);
    }
    if (signal.dataType === "BOOL" && (signal.rangeMin !== null || signal.rangeMax !== null || signal.unit !== null)) {
      issues.push(`signal ${signal.key}: a BOOL signal has no range and no unit`);
    }
    if (signal.roleKey === null) continue;
    const role = roles.get(signal.roleKey);
    if (!role) {
      issues.push(`signal ${signal.key} belongs to unknown role ${signal.roleKey}`);
      continue;
    }
    // A signal of a device must not exist in a profile that has no place for the device.
    const signalProfiles = signal.profiles.length > 0 ? signal.profiles : type.profiles;
    const missing = signalProfiles.filter((profile) => profiles.has(profile) && !appliesToProfile(role, profile));
    if (missing.length > 0) {
      issues.push(`signal ${signal.key} applies to ${missing.join(", ")}, where its role ${role.key} does not exist`);
    }
    // A required signal needs its device: an optional role cannot carry one.
    if (signal.required && !role.required) {
      issues.push(`signal ${signal.key} is required but its role ${role.key} is optional`);
    }
  }

  for (const field of type.configFields) {
    if (field.type === "choice" && field.options.length === 0) {
      issues.push(`configuration field ${field.key} offers no option`);
    }
    if (field.type !== "choice" && field.options.length > 0) {
      issues.push(`configuration field ${field.key}: only a choice has options`);
    }
    const numeric = field.type === "number" || field.type === "integer";
    if (!numeric && (field.min !== null || field.max !== null || field.unit !== null)) {
      issues.push(`configuration field ${field.key}: only a number has limits and a unit`);
    }
    if (field.min !== null && field.max !== null && field.min > field.max) {
      issues.push(`configuration field ${field.key}: the lower limit is above the upper limit`);
    }
    if (field.defaultValue !== null) {
      const problem = checkConfigValue(field, field.defaultValue);
      if (problem) issues.push(`configuration field ${field.key}: the default ${problem}`);
    }
  }
  return issues;
}

/**
 * The profile a new or changed instance gets. A type with profiles needs one of them
 * (its first when none is asked for); a type without takes none.
 */
export function resolveProfile(type: { profiles: readonly string[] }, requested: string | null | undefined) {
  if (type.profiles.length === 0) {
    if (requested) {
      throw new DomainError("VALIDATION", "This module type has no profiles.", { rule: "module-profile" });
    }
    return null;
  }
  const profile = requested ?? type.profiles[0] ?? null;
  if (profile === null || !type.profiles.includes(profile)) {
    throw new DomainError(
      "VALIDATION",
      `Choose one of the profiles of this module type: ${type.profiles.join(", ")}.`,
      {
        rule: "module-profile",
        field: "profile",
      },
    );
  }
  return profile;
}

/**
 * An instance's configuration, checked against the fields its type declares and filled
 * with their defaults. Nothing the type does not declare is stored.
 */
export function resolveModuleConfig(
  fields: readonly ModuleConfigField[],
  input: Readonly<Record<string, unknown>>,
): Record<string, ModuleConfigValue> {
  const known = new Set(fields.map((field) => field.key));
  const unknown = Object.keys(input).find((key) => !known.has(key));
  if (unknown !== undefined) {
    throw new DomainError("VALIDATION", `This module type has no setting "${unknown}".`, {
      rule: "module-config",
      field: unknown,
    });
  }
  const config: Record<string, ModuleConfigValue> = {};
  for (const field of fields) {
    const value = input[field.key] ?? field.defaultValue;
    if (value === null || value === undefined) {
      throw new DomainError("VALIDATION", `${field.label} has to be set.`, { rule: "module-config", field: field.key });
    }
    const problem = checkConfigValue(field, value);
    if (problem) {
      throw new DomainError("VALIDATION", `${field.label} ${problem}.`, { rule: "module-config", field: field.key });
    }
    config[field.key] = value as ModuleConfigValue;
  }
  return config;
}

/** True when a device of the category can fill the role. */
export function roleAcceptsCategory(role: { deviceCategoryCodes: readonly string[] }, categoryCode: string): boolean {
  return role.deviceCategoryCodes.length === 0 || role.deviceCategoryCodes.includes(categoryCode);
}

// ───────────────────────────── interlocks ─────────────────────────────

/** How an interlock condition reads a signal: a BOOL is true or false, a number is compared. */
export const INTERLOCK_OPERATORS = ["IS_TRUE", "IS_FALSE", "GT", "GE", "LT", "LE", "EQ", "NE"] as const;

export type InterlockOperator = (typeof INTERLOCK_OPERATORS)[number];

export type InterlockCondition = {
  /** Key of a signal of the module. */
  signal: string;
  operator: InterlockOperator;
  /** The value a number is compared with, in the signal's engineering unit. */
  value?: number;
};

/**
 * Interlock metadata: while every condition holds, the listed outputs are expected to be
 * held off. It documents and tests the control program; it is never a safety function.
 */
export type InterlockExpression = {
  when: InterlockCondition[];
  /** Keys of the OUTPUT signals the interlock blocks. */
  blocks: string[];
};

const isBoolOperator = (operator: InterlockOperator) => operator === "IS_TRUE" || operator === "IS_FALSE";

/** What is wrong with an interlock for a module with these signals. Empty when it is sound. */
export function checkInterlock(
  expression: InterlockExpression,
  signals: ReadonlyArray<Pick<ModuleSignal, "key" | "direction" | "dataType" | "rangeMin" | "rangeMax">>,
): string[] {
  const byKey = new Map(signals.map((signal) => [signal.key, signal]));
  const issues: string[] = [];
  for (const condition of expression.when) {
    const signal = byKey.get(condition.signal);
    if (!signal) {
      issues.push(`signal ${condition.signal} is not part of this module`);
      continue;
    }
    if (signal.dataType === "BOOL") {
      if (!isBoolOperator(condition.operator) || condition.value !== undefined) {
        issues.push(`${signal.key} is a BOOL: use IS_TRUE or IS_FALSE without a value`);
      }
      continue;
    }
    if (isBoolOperator(condition.operator) || condition.value === undefined) {
      issues.push(`${signal.key} is a number: compare it with a value`);
      continue;
    }
    const below = signal.rangeMin !== null && condition.value < signal.rangeMin;
    const above = signal.rangeMax !== null && condition.value > signal.rangeMax;
    if (below || above) {
      issues.push(`${signal.key}: ${condition.value} is outside its range ${signal.rangeMin} to ${signal.rangeMax}`);
    }
  }
  for (const key of expression.blocks) {
    const signal = byKey.get(key);
    if (!signal) issues.push(`signal ${key} is not part of this module`);
    else if (signal.direction !== "OUTPUT") issues.push(`${key} is not an output: an interlock blocks outputs`);
  }
  for (const key of duplicates(expression.blocks)) issues.push(`output ${key} is listed twice`);
  return issues;
}

// ───────────────────────────── validation of an instance ─────────────────────────────

export type ModuleIssueRule =
  /** A required role has no device. */
  | "module-role-empty"
  /** A role has more devices than it allows. */
  | "module-role-full"
  /** A device is assigned to a role the selected profile does not have. */
  | "module-role-profile"
  /** A device is of a category its role does not accept. */
  | "module-role-category"
  /** An interlock refers to signals the module does not have, or misreads one. */
  | "module-interlock";

export type ModuleIssue = {
  rule: ModuleIssueRule;
  message: string;
  /** The role or interlock the issue is about. */
  subject: string;
};

export type ModuleAssignment = { roleKey: string; deviceName: string; categoryCode: string };

/**
 * What keeps a module from being complete as it is stored. The service refuses changes
 * that would cause most of these; they still arise when a device is deleted or the
 * catalog moves a model to another category. Unbound signals are the registry's concern.
 */
export function moduleIssues(module: {
  profile: string | null;
  roles: readonly ModuleRole[];
  signals: readonly ModuleSignal[];
  assignments: readonly ModuleAssignment[];
  interlocks: ReadonlyArray<{ code: string; enabled: boolean; expression: InterlockExpression }>;
}): ModuleIssue[] {
  const issues: ModuleIssue[] = [];
  const roles = new Map(module.roles.map((role) => [role.key, role]));

  for (const role of effectiveRoles(module.roles, module.profile)) {
    const count = module.assignments.filter((assignment) => assignment.roleKey === role.key).length;
    if (role.required && count === 0) {
      issues.push({ rule: "module-role-empty", subject: role.key, message: `${role.name} has no device.` });
    }
    if (count > role.maxDevices) {
      issues.push({
        rule: "module-role-full",
        subject: role.key,
        message: `${role.name} has ${count} devices; it takes ${role.maxDevices}.`,
      });
    }
  }

  for (const assignment of module.assignments) {
    const role = roles.get(assignment.roleKey);
    if (!role) continue;
    if (!appliesToProfile(role, module.profile)) {
      issues.push({
        rule: "module-role-profile",
        subject: role.key,
        message: `${assignment.deviceName} is assigned as ${role.name}, which the selected profile does not have.`,
      });
    } else if (!roleAcceptsCategory(role, assignment.categoryCode)) {
      issues.push({
        rule: "module-role-category",
        subject: role.key,
        message: `${assignment.deviceName} is a ${assignment.categoryCode}; ${role.name} takes ${role.deviceCategoryCodes.join(", ")}.`,
      });
    }
  }

  const signals = effectiveSignals(module.signals, module.profile);
  for (const interlock of module.interlocks) {
    if (!interlock.enabled) continue;
    const [first] = checkInterlock(interlock.expression, signals);
    if (first)
      issues.push({ rule: "module-interlock", subject: interlock.code, message: `${interlock.code}: ${first}.` });
  }
  return issues;
}
