import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { ModuleTypeDefinition } from "@/lib/domain/process-module";
import type { Prisma, Severity } from "@/lib/generated/prisma/client";
import { insertModuleType, moduleTypeInclude } from "@/lib/process-modules/ingest";

const moduleInclude = {
  processModuleType: { include: moduleTypeInclude },
  devices: {
    orderBy: { createdAt: "asc" },
    include: {
      moduleRole: { select: { key: true } },
      deviceInstance: {
        select: {
          id: true,
          name: true,
          deviceModel: {
            select: {
              modelName: true,
              family: {
                select: { manufacturer: { select: { name: true } }, category: { select: { code: true, name: true } } },
              },
            },
          },
        },
      },
    },
  },
  interlocks: { orderBy: { code: "asc" } },
  mappings: {
    orderBy: { createdAt: "asc" },
    include: {
      moduleSignalDefinition: { select: { key: true } },
      tag: { include: { plc: { select: { deviceInstance: { select: { id: true, name: true } } } } } },
    },
  },
} as const satisfies Prisma.ProcessModuleInstanceInclude;

export type ModuleRecord = NonNullable<Awaited<ReturnType<typeof processModuleRepository.findModule>>>;

export type InterlockData = {
  code: string;
  name: string;
  description: string | null;
  severity: Severity;
  enabled: boolean;
  expressionJson: Prisma.InputJsonValue;
};

/** Process-module types (shared reference data) and the module instances of a factory. */
export const processModuleRepository = {
  /** Every type version, newest version of a code first. */
  listTypes(db: Db) {
    return db.processModuleType.findMany({
      orderBy: [{ code: "asc" }, { version: "desc" }],
      include: moduleTypeInclude,
    });
  },

  findType(db: Db, typeId: string) {
    return db.processModuleType.findUnique({ where: { id: typeId }, include: moduleTypeInclude });
  },

  createType(db: Prisma.TransactionClient, type: ModuleTypeDefinition) {
    return withDomainErrors(() => insertModuleType(db, type));
  },

  /** A module of one of the owner's factories, with its type, devices and interlocks. */
  findModule(db: Db, ownerId: string, moduleId: string) {
    return db.processModuleInstance.findFirst({
      where: { id: moduleId, factory: { ownerId } },
      include: moduleInclude,
    });
  },

  listModules(db: Db, factoryId: string) {
    return db.processModuleInstance.findMany({
      where: { factoryId },
      orderBy: { name: "asc" },
      include: moduleInclude,
    });
  },

  createModule(
    db: Db,
    data: {
      factoryId: string;
      processModuleTypeId: string;
      name: string;
      location: string | null;
      profile: string | null;
      configJson: Prisma.InputJsonValue;
    },
  ) {
    return withDomainErrors(() => db.processModuleInstance.create({ data, select: { id: true } }));
  },

  updateModule(
    db: Db,
    moduleId: string,
    data: { name?: string; location?: string | null; profile?: string | null; configJson?: Prisma.InputJsonValue },
  ) {
    return withDomainErrors(() => db.processModuleInstance.update({ where: { id: moduleId }, data }));
  },

  deleteModule(db: Db, moduleId: string) {
    return db.processModuleInstance.delete({ where: { id: moduleId } });
  },

  /** Holds the module's row for the rest of the transaction, so two assignments cannot both take a role's last place. */
  lockModule(db: Prisma.TransactionClient, moduleId: string) {
    return db.$queryRaw`SELECT "id" FROM "ProcessModuleInstance" WHERE "id" = ${moduleId}::uuid FOR UPDATE`;
  },

  /** A device of one of the owner's factories, with the category that decides which roles it can fill. */
  findDevice(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({
      where: { id: deviceId, factory: { ownerId } },
      select: {
        id: true,
        name: true,
        factoryId: true,
        deviceModel: { select: { family: { select: { category: { select: { code: true, name: true } } } } } },
      },
    });
  },

  countRoleDevices(db: Db, moduleId: string, roleId: string) {
    return db.moduleDevice.count({ where: { processModuleInstanceId: moduleId, moduleRoleDefinitionId: roleId } });
  },

  createAssignment(db: Db, data: { moduleId: string; roleId: string; deviceId: string }) {
    return withDomainErrors(() =>
      db.moduleDevice.create({
        data: {
          processModuleInstanceId: data.moduleId,
          moduleRoleDefinitionId: data.roleId,
          deviceInstanceId: data.deviceId,
        },
        select: { id: true },
      }),
    );
  },

  deleteAssignment(db: Db, moduleId: string, assignmentId: string) {
    return db.moduleDevice.deleteMany({ where: { id: assignmentId, processModuleInstanceId: moduleId } });
  },

  createInterlock(db: Db, moduleId: string, data: InterlockData) {
    return withDomainErrors(() =>
      db.moduleInterlock.create({ data: { ...data, processModuleInstanceId: moduleId }, select: { id: true } }),
    );
  },

  updateInterlock(db: Db, interlockId: string, data: InterlockData) {
    return withDomainErrors(() => db.moduleInterlock.update({ where: { id: interlockId }, data }));
  },

  deleteInterlock(db: Db, moduleId: string, interlockId: string) {
    return db.moduleInterlock.deleteMany({ where: { id: interlockId, processModuleInstanceId: moduleId } });
  },

  // ───────────── module PLC I/O registry (TASK-605) ─────────────

  /** Who holds a tag, if a module does. */
  findMappingByTag(db: Db, tagId: string) {
    return db.modulePlcIoMapping.findUnique({
      where: { tagId },
      include: {
        processModuleInstance: { select: { id: true, name: true } },
        moduleSignalDefinition: { select: { key: true, name: true } },
      },
    });
  },

  createMapping(db: Db, data: { moduleId: string; signalId: string; plcId: string; tagId: string }) {
    return withDomainErrors(() =>
      db.modulePlcIoMapping.create({
        data: {
          processModuleInstanceId: data.moduleId,
          moduleSignalDefinitionId: data.signalId,
          plcInstanceId: data.plcId,
          tagId: data.tagId,
        },
        select: { id: true },
      }),
    );
  },

  /** Moves a signal's binding to another tag. */
  updateMapping(db: Db, mappingId: string, data: { plcId: string; tagId: string }) {
    return withDomainErrors(() =>
      db.modulePlcIoMapping.update({
        where: { id: mappingId },
        data: { plcInstanceId: data.plcId, tagId: data.tagId },
        select: { id: true },
      }),
    );
  },

  deleteMapping(db: Db, moduleId: string, mappingId: string) {
    return db.modulePlcIoMapping.deleteMany({ where: { id: mappingId, processModuleInstanceId: moduleId } });
  },

  deleteModuleMappings(db: Db, moduleId: string) {
    return db.modulePlcIoMapping.deleteMany({ where: { processModuleInstanceId: moduleId } });
  },

  /** The tags of every PLC of a factory, with whether a module holds each; candidates for a signal. */
  listFactoryTags(db: Db, factoryId: string) {
    return db.tag.findMany({
      where: { plc: { deviceInstance: { factoryId } } },
      include: {
        plc: { select: { deviceInstance: { select: { id: true, name: true } } } },
        moduleMapping: {
          select: {
            processModuleInstance: { select: { id: true, name: true } },
            moduleSignalDefinition: { select: { key: true } },
          },
        },
      },
      orderBy: [{ plc: { deviceInstance: { name: "asc" } } }, { name: "asc" }],
    });
  },

  /** The modules whose signals tags of one PLC carry, once per module (edge deployment, TASK-503). */
  listPlcModules(db: Db, plcId: string) {
    return db.modulePlcIoMapping.findMany({
      where: { plcInstanceId: plcId },
      distinct: ["processModuleInstanceId"],
      select: {
        processModuleInstanceId: true,
        processModuleInstance: { select: { name: true, processModuleType: { select: { code: true } } } },
      },
    });
  },

  /** The module signals carried by tags of one PLC, for its engineering export. */
  listPlcMappings(db: Db, plcId: string) {
    return db.modulePlcIoMapping.findMany({
      where: { plcInstanceId: plcId },
      select: {
        moduleSignalDefinition: { select: { key: true, direction: true } },
        processModuleInstance: { select: { name: true, processModuleType: { select: { code: true } } } },
        tag: { select: { name: true, logicalAddress: true } },
      },
      orderBy: [{ processModuleInstance: { name: "asc" } }, { tag: { name: "asc" } }],
    });
  },

  /** Every module binding of a factory with the PLC it uses, for the per-PLC summary and the bridge. */
  listFactoryMappings(db: Db, factoryId: string) {
    return db.modulePlcIoMapping.findMany({
      where: { processModuleInstance: { factoryId } },
      select: {
        processModuleInstanceId: true,
        tagId: true,
        plcInstanceId: true,
        moduleSignalDefinition: { select: { key: true, direction: true } },
        processModuleInstance: { select: { name: true } },
        plc: { select: { deviceInstance: { select: { name: true } } } },
      },
      orderBy: [{ processModuleInstance: { name: "asc" } }, { createdAt: "asc" }],
    });
  },
};
