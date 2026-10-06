import "server-only";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import type { ProcessTagRecord } from "@/lib/db/repositories/process-bridge-repository";
import { type ModuleRecord, processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { DomainError } from "@/lib/domain/errors";
import { buildModuleIo, type StoredModuleBinding } from "@/lib/domain/module-io-view";
import type { ProcessSignalTag } from "@/lib/domain/process-bridge";
import {
  appliesToProfile,
  checkInterlock,
  countSignals,
  effectiveRoles,
  effectiveSignals,
  type InterlockExpression,
  moduleIssues,
  type ModuleTypeDefinition,
  resolveModuleConfig,
  resolveProfile,
  roleAcceptsCategory,
} from "@/lib/domain/process-module";
import type {
  ModuleDetail,
  ModuleDeviceView,
  ModuleInterlockView,
  ModuleSummary,
  ModuleTypeDetail,
  ModuleTypeSummary,
} from "@/lib/domain/process-module-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type ModuleTypeRecord, toModuleTypeDefinition } from "@/lib/process-modules/ingest";
import { parseModuleType } from "@/lib/process-modules/schema";
import { parseInput } from "@/lib/validation/parse";
import {
  interlockExpressionSchema,
  moduleAssignmentInputSchema,
  moduleInputSchema,
  moduleInterlockInputSchema,
  moduleInterlockUpdateSchema,
  moduleUpdateSchema,
} from "@/lib/validation/process-module";
import { getFactory } from "./factory-service";

/**
 * Process modules (TASK-601, docs/process-modules.md). A module type is shared reference
 * data, like the catalog: a template with roles and a logical I/O contract. A module
 * instance belongs to a factory and gives existing devices of that factory a role in it.
 *
 * A module never changes a device and reserves no PLC endpoint. Binding its signals to
 * tags and I/O points is the module I/O registry (TASK-605).
 */

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);
const isUuid = (value: string) => z.uuid().safeParse(value).success;

// ───────────────────────────── module types ─────────────────────────────

function toTypeSummary(record: ModuleTypeRecord, type: ModuleTypeDefinition, latest: boolean): ModuleTypeSummary {
  return {
    id: record.id,
    code: type.code,
    name: type.name,
    version: type.version,
    description: type.description,
    simulatorModelType: type.simulatorModelType,
    profiles: type.profiles,
    latest,
    roleCount: type.roles.length,
    signalCounts: countSignals(type.signals),
  };
}

/** Every stored type version; the newest version of each code is marked `latest`. */
export async function listModuleTypes(db: PrismaClient): Promise<ModuleTypeSummary[]> {
  const records = await processModuleRepository.listTypes(db);
  const seen = new Set<string>();
  return records.map((record) => {
    const latest = !seen.has(record.code);
    seen.add(record.code);
    return toTypeSummary(record, toModuleTypeDefinition(record), latest);
  });
}

export async function getModuleType(db: PrismaClient, typeId: string): Promise<ModuleTypeDetail> {
  const records = isUuid(typeId) ? await processModuleRepository.listTypes(db) : [];
  const record = records.find((candidate) => candidate.id === typeId);
  if (!record) throw notFound("module type");
  const type = toModuleTypeDefinition(record);
  const newest = records.find((candidate) => candidate.code === record.code);
  return {
    ...toTypeSummary(record, type, newest?.id === record.id),
    configFields: type.configFields,
    roles: type.roles,
    signals: type.signals,
  };
}

/**
 * Stores a module type version. Types are reference data of the installation, not of a
 * factory; a stored version is never changed, so a changed template is a new version.
 */
export async function defineModuleType(db: PrismaClient, input: unknown): Promise<ModuleTypeDetail> {
  const type = parseModuleType(input);
  const id = await db.$transaction((transaction) => processModuleRepository.createType(transaction, type));
  return getModuleType(db, id);
}

// ───────────────────────────── module instances ─────────────────────────────

const parseExpression = (json: unknown): InterlockExpression => {
  const result = interlockExpressionSchema.safeParse(json);
  return result.success ? result.data : { when: [], blocks: [] };
};

function toInterlockView(interlock: ModuleRecord["interlocks"][number]): ModuleInterlockView {
  return {
    id: interlock.id,
    code: interlock.code,
    name: interlock.name,
    description: interlock.description,
    severity: interlock.severity,
    enabled: interlock.enabled,
    expression: parseExpression(interlock.expressionJson),
  };
}

function toDeviceView(assignment: ModuleRecord["devices"][number]): ModuleDeviceView {
  const { deviceInstance: device } = assignment;
  const { family } = device.deviceModel;
  return {
    assignmentId: assignment.id,
    deviceId: device.id,
    name: device.name,
    categoryCode: family.category.code,
    categoryName: family.category.name,
    manufacturer: family.manufacturer.name,
    modelName: device.deviceModel.modelName,
  };
}

export function toSignalTag(tag: ModuleRecord["mappings"][number]["tag"] | ProcessTagRecord): ProcessSignalTag {
  return {
    id: tag.id,
    plcId: tag.plcInstanceId,
    name: tag.name,
    dataType: tag.dataType,
    role: tag.role,
    accessMode: tag.accessMode,
    logicalAddress: tag.logicalAddress,
    protocolArea: tag.protocolArea,
    protocolAddress: tag.protocolAddress,
    wordCount: tag.wordCount,
    byteOrder: tag.byteOrder,
    wordOrder: tag.wordOrder,
    scale: tag.scale,
    offset: tag.offset,
    unit: tag.unit,
    sourceDeviceInstanceId: tag.sourceDeviceInstanceId,
  };
}

/** A module's stored bindings as the registry rules read them. */
export function storedBindings(record: ModuleRecord): StoredModuleBinding[] {
  return record.mappings.map((mapping) => ({
    mappingId: mapping.id,
    signalKey: mapping.moduleSignalDefinition.key,
    plcName: mapping.tag.plc.deviceInstance.name,
    tag: toSignalTag(mapping.tag),
    ioPointId: mapping.tag.plcIoPointId,
  }));
}

/** A stored module as its screen shows it, with the issues that keep it from being complete. */
export function toModuleDetail(record: ModuleRecord): ModuleDetail {
  return toDetail(record);
}

function toDetail(record: ModuleRecord): ModuleDetail {
  const type = toModuleTypeDefinition(record.processModuleType);
  const signals = effectiveSignals(type.signals, record.profile);
  const interlocks = record.interlocks.map(toInterlockView);
  const issues = moduleIssues({
    profile: record.profile,
    roles: type.roles,
    signals: type.signals,
    assignments: record.devices.map((assignment) => ({
      roleKey: assignment.moduleRole.key,
      deviceName: assignment.deviceInstance.name,
      categoryCode: assignment.deviceInstance.deviceModel.family.category.code,
    })),
    interlocks,
  });
  const io = buildModuleIo(type.signals, record.profile, storedBindings(record));
  const bound = io.counts.INPUT.bound + io.counts.OUTPUT.bound + io.counts.ALARM.bound;
  const invalid = io.counts.INPUT.invalid + io.counts.OUTPUT.invalid + io.counts.ALARM.invalid;
  const requiredUnbound =
    io.counts.INPUT.requiredUnbound + io.counts.OUTPUT.requiredUnbound + io.counts.ALARM.requiredUnbound;
  return {
    id: record.id,
    factoryId: record.factoryId,
    name: record.name,
    location: record.location,
    status: record.status,
    profile: record.profile,
    type: { id: record.processModuleType.id, code: type.code, name: type.name, version: type.version },
    deviceCount: record.devices.length,
    signalCounts: countSignals(signals),
    complete: issues.length === 0,
    issues,
    bindings: { bound, invalid, requiredUnbound },
    readyToRun: issues.length === 0 && !io.blocking && type.simulatorModelType !== null,
    // Read through the type again, so a stored configuration never shows a setting the type does not declare.
    config: readConfig(type, record.configJson),
    configFields: type.configFields,
    roles: effectiveRoles(type.roles, record.profile).map((role) => ({
      ...role,
      devices: record.devices.filter((assignment) => assignment.moduleRole.key === role.key).map(toDeviceView),
    })),
    signals,
    interlocks,
  };
}

function readConfig(type: ModuleTypeDefinition, json: unknown) {
  const stored = z.record(z.string(), z.unknown()).safeParse(json);
  const known = new Set(type.configFields.map((field) => field.key));
  const values = Object.fromEntries(
    Object.entries(stored.success ? stored.data : {}).filter(([key]) => known.has(key)),
  );
  return resolveModuleConfig(type.configFields, values);
}

function toSummary(detail: ModuleDetail): ModuleSummary {
  const {
    config: _config,
    configFields: _fields,
    roles: _roles,
    signals: _signals,
    interlocks: _locks,
    ...summary
  } = detail;
  return summary;
}

/** A module of one of the actor's factories, with its type, devices, interlocks and bindings. */
export async function loadModule(db: PrismaClient, actor: Actor, moduleId: string): Promise<ModuleRecord> {
  const record = isUuid(moduleId) ? await processModuleRepository.findModule(db, actor.ownerId, moduleId) : null;
  if (!record) throw notFound("process module");
  return record;
}

/** The modules of a factory, in name order. */
export async function listModules(db: PrismaClient, actor: Actor, factoryId: string): Promise<ModuleSummary[]> {
  const factory = await getFactory(db, actor, factoryId);
  const records = await processModuleRepository.listModules(db, factory.id);
  return records.map((record) => toSummary(toDetail(record)));
}

export async function getModule(db: PrismaClient, actor: Actor, moduleId: string): Promise<ModuleDetail> {
  return toDetail(await loadModule(db, actor, moduleId));
}

/** Creates a module of a type in a factory. Its name is unique within the factory. */
export async function createModule(db: PrismaClient, actor: Actor, input: unknown): Promise<ModuleDetail> {
  const data = parseInput(moduleInputSchema, input);
  const factory = await getFactory(db, actor, data.factoryId);
  const record = await processModuleRepository.findType(db, data.typeId);
  if (!record) throw notFound("module type");
  const type = toModuleTypeDefinition(record);

  const { id } = await processModuleRepository.createModule(db, {
    factoryId: factory.id,
    processModuleTypeId: record.id,
    name: data.name,
    location: data.location || null,
    profile: resolveProfile(type, data.profile),
    configJson: resolveModuleConfig(type.configFields, data.config),
  });
  return getModule(db, actor, id);
}

/**
 * Renames a module, moves it, changes its settings or selects another profile. A profile
 * is refused while the module holds devices or interlocks the profile has no place for:
 * nothing is unassigned as a side effect.
 */
export async function updateModule(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleDetail> {
  const data = parseInput(moduleUpdateSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const type = toModuleTypeDefinition(record.processModuleType);

  const profile = data.profile === undefined ? undefined : resolveProfile(type, data.profile);
  if (profile !== undefined && profile !== record.profile) {
    const stranded = record.devices.find((assignment) => {
      const role = type.roles.find((candidate) => candidate.key === assignment.moduleRole.key);
      return role !== undefined && !appliesToProfile(role, profile);
    });
    if (stranded) {
      throw new DomainError(
        "CONFLICT",
        `${stranded.deviceInstance.name} is assigned to ${stranded.moduleRole.key}, which the profile ${profile} does not have. Unassign it first.`,
        { rule: "module-profile-in-use", roleKey: stranded.moduleRole.key },
      );
    }
    const signals = effectiveSignals(type.signals, profile);
    for (const interlock of record.interlocks) {
      const [issue] = checkInterlock(parseExpression(interlock.expressionJson), signals);
      if (issue) {
        throw new DomainError(
          "CONFLICT",
          `The interlock ${interlock.code} does not fit the profile ${profile}: ${issue}. Change or remove it first.`,
          { rule: "module-profile-in-use", interlock: interlock.code },
        );
      }
    }
  }

  await processModuleRepository.updateModule(db, record.id, {
    name: data.name,
    location: data.location === undefined ? undefined : data.location || null,
    profile,
    configJson: data.config === undefined ? undefined : resolveModuleConfig(type.configFields, data.config),
  });
  return getModule(db, actor, record.id);
}

/** Removes the module with its role assignments and interlocks. Its devices stay in the factory. */
export async function deleteModule(db: PrismaClient, actor: Actor, moduleId: string): Promise<void> {
  const record = await loadModule(db, actor, moduleId);
  await processModuleRepository.deleteModule(db, record.id);
}

// ───────────────────────────── device roles ─────────────────────────────

/**
 * Gives a device of the module's factory a role in the module. The device is not
 * changed: it keeps its model, its wiring and its tags, and may serve other modules too.
 */
export async function assignModuleDevice(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleDetail> {
  const data = parseInput(moduleAssignmentInputSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const role = record.processModuleType.roles.find((candidate) => candidate.key === data.roleKey);
  if (!role) throw new DomainError("NOT_FOUND", `This module type has no role ${data.roleKey}.`, { field: "roleKey" });
  if (!appliesToProfile(role, record.profile)) {
    throw new DomainError("INCOMPATIBLE", `The profile ${record.profile} has no ${role.name}.`, {
      rule: "module-role-profile",
      roleKey: role.key,
    });
  }

  const device = await processModuleRepository.findDevice(db, actor.ownerId, data.deviceId);
  if (!device) throw notFound("device");
  if (device.factoryId !== record.factoryId) {
    throw new DomainError("INVARIANT", `${device.name} belongs to another factory.`, {
      rule: "module-device-factory",
      deviceId: device.id,
    });
  }
  const category = device.deviceModel.family.category;
  if (!roleAcceptsCategory(role, category.code)) {
    throw new DomainError(
      "INCOMPATIBLE",
      `${device.name} is a ${category.name}; ${role.name} takes ${role.deviceCategoryCodes.join(", ")}.`,
      { rule: "module-role-category", roleKey: role.key, categoryCode: category.code },
    );
  }

  await db.$transaction(async (transaction) => {
    await processModuleRepository.lockModule(transaction, record.id);
    const taken = await processModuleRepository.countRoleDevices(transaction, record.id, role.id);
    if (taken >= role.maxDevices) {
      throw new DomainError(
        "CONFLICT",
        role.maxDevices === 1 ? `${role.name} already has its device.` : `${role.name} already has ${taken} devices.`,
        { rule: "module-role-full", roleKey: role.key },
      );
    }
    await processModuleRepository.createAssignment(transaction, {
      moduleId: record.id,
      roleId: role.id,
      deviceId: device.id,
    });
  });
  return getModule(db, actor, record.id);
}

/** Takes a device out of its role. The device itself stays as it is. */
export async function unassignModuleDevice(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  assignmentId: string,
): Promise<ModuleDetail> {
  const record = await loadModule(db, actor, moduleId);
  const removed = isUuid(assignmentId)
    ? await processModuleRepository.deleteAssignment(db, record.id, assignmentId)
    : { count: 0 };
  if (removed.count === 0) throw notFound("role assignment");
  return getModule(db, actor, record.id);
}

// ───────────────────────────── interlocks ─────────────────────────────

function assertInterlock(record: ModuleRecord, expression: InterlockExpression): void {
  const type = toModuleTypeDefinition(record.processModuleType);
  const issues = checkInterlock(expression, effectiveSignals(type.signals, record.profile));
  if (issues.length > 0) {
    throw new DomainError("VALIDATION", `The interlock does not fit this module: ${issues[0]}.`, {
      rule: "module-interlock",
      issues,
    });
  }
}

/**
 * Records an interlock of the module: while its conditions hold, the outputs it names
 * are expected to be held off. It is metadata for validation, documentation and tests of
 * the control program, and never a safety function.
 */
export async function addModuleInterlock(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleDetail> {
  const { expression, description, ...data } = parseInput(moduleInterlockInputSchema, input);
  const record = await loadModule(db, actor, moduleId);
  assertInterlock(record, expression);
  await processModuleRepository.createInterlock(db, record.id, {
    ...data,
    description: description || null,
    expressionJson: expression,
  });
  return getModule(db, actor, record.id);
}

/** Changes an interlock; what is left out stays. Its code is fixed. */
export async function updateModuleInterlock(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  interlockId: string,
  input: unknown,
): Promise<ModuleDetail> {
  const data = parseInput(moduleInterlockUpdateSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const stored = record.interlocks.find((interlock) => interlock.id === interlockId);
  if (!stored) throw notFound("interlock");
  const expression = data.expression ?? parseExpression(stored.expressionJson);
  assertInterlock(record, expression);
  await processModuleRepository.updateInterlock(db, stored.id, {
    code: stored.code,
    name: data.name ?? stored.name,
    description: data.description === undefined ? stored.description : data.description || null,
    severity: data.severity ?? stored.severity,
    enabled: data.enabled ?? stored.enabled,
    expressionJson: expression,
  });
  return getModule(db, actor, record.id);
}

export async function removeModuleInterlock(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  interlockId: string,
): Promise<ModuleDetail> {
  const record = await loadModule(db, actor, moduleId);
  const removed = isUuid(interlockId)
    ? await processModuleRepository.deleteInterlock(db, record.id, interlockId)
    : { count: 0 };
  if (removed.count === 0) throw notFound("interlock");
  return getModule(db, actor, record.id);
}
