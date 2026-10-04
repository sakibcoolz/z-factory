import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { Prisma, ProgramVersionStatus, RuntimeState, Severity } from "@/lib/generated/prisma/client";

const plcInclude = {
  factory: true,
  plcProfile: { include: { programVersion: true } },
  runtimePorts: true,
  deviceModel: { include: { family: { include: { category: true, manufacturer: true } } } },
} as const;

export type PlcRecord = NonNullable<Awaited<ReturnType<typeof plcRepository.findForOwner>>>;

export const plcRepository = {
  /** A device of one of the owner's factories, with what the runtime layer needs to know about it. */
  findForOwner(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({ where: { id: deviceId, factory: { ownerId } }, include: plcInclude });
  },

  async nextProgramVersion(db: Db, plcInstanceId: string): Promise<number> {
    const latest = await db.programVersion.aggregate({ where: { plcInstanceId }, _max: { version: true } });
    return (latest._max.version ?? 0) + 1;
  },

  createProgramVersion(db: Db, data: { plcInstanceId: string; version: number; sourceText: string; checksum: string }) {
    return withDomainErrors(() => db.programVersion.create({ data }));
  },

  findProgramVersion(db: Db, plcInstanceId: string, programVersionId: string) {
    return db.programVersion.findFirst({ where: { id: programVersionId, plcInstanceId } });
  },

  listProgramVersions(db: Db, plcInstanceId: string) {
    return db.programVersion.findMany({ where: { plcInstanceId }, orderBy: { version: "asc" } });
  },

  selectProgramVersion(db: Db, plcInstanceId: string, programVersionId: string) {
    return db.plcInstanceProfile.update({ where: { deviceInstanceId: plcInstanceId }, data: { programVersionId } });
  },

  setProgramStatus(db: Db, programVersionId: string, status: ProgramVersionStatus, compiledArtifactRef?: string) {
    return db.programVersion.update({ where: { id: programVersionId }, data: { status, compiledArtifactRef } });
  },

  /** The version that was running before a new deployment is no longer DEPLOYED. */
  retireDeployedPrograms(db: Db, plcInstanceId: string, exceptId: string) {
    return db.programVersion.updateMany({
      where: { plcInstanceId, status: "DEPLOYED", id: { not: exceptId } },
      data: { status: "COMPILED" },
    });
  },

  setDeviceRuntime(
    db: Db,
    deviceId: string,
    data: { runtimeStatus?: RuntimeState; dockerContainerId?: string | null; hostName?: string | null },
  ) {
    return db.deviceInstance.update({ where: { id: deviceId }, data });
  },

  setRuntimeMetadata(
    db: Db,
    deviceId: string,
    data: {
      runtimeImage?: string | null;
      runtimeVersion?: string | null;
      imageDigest?: string | null;
      apiHostPort?: number | null;
    },
  ) {
    return withDomainErrors(() => db.plcInstanceProfile.update({ where: { deviceInstanceId: deviceId }, data }));
  },

  async replaceModbusPort(
    db: Db,
    deviceId: string,
    port: { containerPort: number; hostPort: number; bindAddress: string } | null,
  ) {
    await db.runtimePort.deleteMany({ where: { deviceInstanceId: deviceId, protocol: "MODBUS_TCP" } });
    if (port) {
      await withDomainErrors(() =>
        db.runtimePort.create({ data: { deviceInstanceId: deviceId, protocol: "MODBUS_TCP", ...port } }),
      );
    }
  },

  /** Host ports other devices have reserved: published Modbus endpoints and management ports. */
  async listReservedHostPorts(
    db: Db,
    exceptDeviceId: string,
  ): Promise<Array<{ hostPort: number; bindAddress: string }>> {
    const [ports, profiles] = await Promise.all([
      db.runtimePort.findMany({
        where: { deviceInstanceId: { not: exceptDeviceId }, hostPort: { not: null } },
        select: { hostPort: true, bindAddress: true },
      }),
      db.plcInstanceProfile.findMany({
        where: { deviceInstanceId: { not: exceptDeviceId }, apiHostPort: { not: null } },
        select: { apiHostPort: true },
      }),
    ]);
    return [
      ...ports.flatMap((port) => (port.hostPort ? [{ hostPort: port.hostPort, bindAddress: port.bindAddress }] : [])),
      ...profiles.flatMap((profile) =>
        profile.apiHostPort ? [{ hostPort: profile.apiHostPort, bindAddress: "127.0.0.1" }] : [],
      ),
    ];
  },

  bumpModbusMappingVersion(db: Db, deviceId: string) {
    return db.plcInstanceProfile.update({
      where: { deviceInstanceId: deviceId },
      data: { modbusMappingVersion: { increment: 1 } },
    });
  },

  recordEvent(
    db: Db,
    event: {
      factoryId: string;
      deviceId: string;
      type: string;
      severity?: Severity;
      payloadJson?: Prisma.InputJsonObject;
    },
  ) {
    return db.runtimeEvent.create({ data: event });
  },

  async recordConfigurationSnapshot(
    db: Db,
    snapshot: { factoryId: string; deviceId: string; createdBy: string; snapshotJson: Prisma.InputJsonObject },
  ) {
    const latest = await db.configurationVersion.aggregate({
      where: { factoryId: snapshot.factoryId, scopeType: "PLC", scopeId: snapshot.deviceId },
      _max: { version: true },
    });
    return db.configurationVersion.create({
      data: {
        factoryId: snapshot.factoryId,
        scopeType: "PLC",
        scopeId: snapshot.deviceId,
        version: (latest._max.version ?? 0) + 1,
        snapshotJson: snapshot.snapshotJson,
        createdBy: snapshot.createdBy,
      },
    });
  },

  /** Runtime states of the factory's OpenPLC devices, for the factory-level summary. */
  async plcRuntimeStates(db: Db, factoryId: string): Promise<RuntimeState[]> {
    const devices = await db.deviceInstance.findMany({
      where: { factoryId, runtimeType: "OPENPLC" },
      select: { runtimeStatus: true },
    });
    return devices.map((device) => device.runtimeStatus);
  },

  setFactoryRuntimeStatus(db: Db, factoryId: string, runtimeStatus: RuntimeState) {
    return db.factory.update({ where: { id: factoryId }, data: { runtimeStatus } });
  },
};
