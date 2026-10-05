/**
 * Writes process-module type definitions to the database. A stored version is never
 * changed: module instances and their PLC bindings refer to its roles and signals. A
 * definition that differs from its stored version is refused; publish it as a new version.
 *
 * Used by `prisma/seed.ts` (plain Node), so this module must not import `server-only`.
 */
import { DomainError } from "@/lib/domain/errors";
import type { ModuleTypeDefinition } from "@/lib/domain/process-module";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { parseConfigFields } from "@/lib/process-modules/schema";

type Tx = Prisma.TransactionClient;

export const moduleTypeInclude = {
  roles: { orderBy: { position: "asc" } },
  signals: { orderBy: { position: "asc" }, include: { moduleRole: { select: { key: true } } } },
} as const satisfies Prisma.ProcessModuleTypeInclude;

export type ModuleTypeRecord = Prisma.ProcessModuleTypeGetPayload<{ include: typeof moduleTypeInclude }>;

/** A stored type as the definition it was written from. */
export function toModuleTypeDefinition(record: ModuleTypeRecord): ModuleTypeDefinition {
  return {
    code: record.code,
    name: record.name,
    version: record.version,
    description: record.description,
    simulatorModelType: record.simulatorModelType,
    profiles: record.profiles,
    configFields: parseConfigFields(record.configSchemaJson),
    roles: record.roles.map((role) => ({
      key: role.key,
      name: role.name,
      description: role.description,
      deviceCategoryCodes: role.deviceCategoryCodes,
      required: role.required,
      maxDevices: role.maxDevices,
      profiles: role.profiles,
    })),
    signals: record.signals.map((signal) => ({
      key: signal.key,
      name: signal.name,
      description: signal.description,
      direction: signal.direction,
      dataType: signal.dataType,
      role: signal.role,
      unit: signal.unit,
      signalType: signal.signalType,
      required: signal.required,
      rangeMin: signal.rangeMin,
      rangeMax: signal.rangeMax,
      roleKey: signal.moduleRole?.key ?? null,
      profiles: signal.profiles,
    })),
  };
}

/** Stores one checked definition as a new type version, with its roles and signals. */
export async function insertModuleType(tx: Tx, type: ModuleTypeDefinition): Promise<string> {
  const created = await tx.processModuleType.create({
    data: {
      code: type.code,
      name: type.name,
      version: type.version,
      description: type.description,
      simulatorModelType: type.simulatorModelType,
      profiles: type.profiles,
      configSchemaJson: { fields: type.configFields },
      roles: { create: type.roles.map((role, position) => ({ ...role, position })) },
    },
    select: { id: true, roles: { select: { id: true, key: true } } },
  });
  const roleIds = new Map(created.roles.map((role) => [role.key, role.id]));
  await tx.moduleSignalDefinition.createMany({
    data: type.signals.map(({ roleKey, ...signal }, position) => ({
      ...signal,
      position,
      processModuleTypeId: created.id,
      moduleRoleDefinitionId: roleKey === null ? null : (roleIds.get(roleKey) ?? null),
    })),
  });
  return created.id;
}

/** JSON with object keys in one order, so two definitions compare by content. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

export type ModuleTypeIngestResult = { created: number; unchanged: number };

/** Idempotent: versions that are stored are left alone, new ones are added. */
export async function ingestModuleTypes(
  db: PrismaClient,
  types: readonly ModuleTypeDefinition[],
): Promise<ModuleTypeIngestResult> {
  return db.$transaction(async (tx) => {
    const result = { created: 0, unchanged: 0 };
    for (const type of types) {
      const stored = await tx.processModuleType.findUnique({
        where: { code_version: { code: type.code, version: type.version } },
        include: moduleTypeInclude,
      });
      if (!stored) {
        await insertModuleType(tx, type);
        result.created += 1;
      } else if (canonical(toModuleTypeDefinition(stored)) === canonical(type)) {
        result.unchanged += 1;
      } else {
        throw new DomainError(
          "CONFLICT",
          `Module type ${type.code} version ${type.version} is stored with other content. Publish the change as a new version.`,
          { rule: "module-type-version", code: type.code, version: type.version },
        );
      }
    }
    return result;
  });
}
