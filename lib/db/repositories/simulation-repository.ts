import "server-only";
import type { Db } from "@/lib/db/client";
import type { Prisma, RuntimeState, TagQuality } from "@/lib/generated/prisma/client";

const deviceInclude = {
  deviceModel: { include: { faultDefinitions: true, simulationProfiles: { orderBy: { id: "desc" } } } },
  simulationProfiles: { orderBy: { id: "desc" } },
  outgoingConnections: { where: { relationship: "MEASURES" } },
  incomingConnections: { where: { relationship: { in: ["DRIVES", "MECHANICALLY_DRIVES"] } } },
} as const satisfies Prisma.DeviceInstanceInclude;

export type SimulatedDeviceRecord = Awaited<ReturnType<typeof simulationRepository.listDevices>>[number];
export type SignalTagRecord = Awaited<ReturnType<typeof simulationRepository.listSignalTags>>[number];

export const simulationRepository = {
  /** Devices of the factory that run in the device simulator, with their behaviour configuration. */
  listDevices(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId, runtimeType: "DEVICE_SIM" },
      include: deviceInclude,
      orderBy: { name: "asc" },
    });
  },

  /** Tags wired to a signal of one of the factory's devices, with the PLC they belong to. */
  listSignalTags(db: Db, factoryId: string) {
    return db.tag.findMany({
      where: { sourceSignal: { not: null }, sourceDevice: { factoryId }, plc: { deviceInstance: { factoryId } } },
      include: { plc: { include: { deviceInstance: { include: { runtimePorts: true } } } } },
      orderBy: [{ plcInstanceId: "asc" }, { protocolArea: "asc" }, { protocolAddress: "asc" }],
    });
  },

  findDeviceForOwner(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({
      where: { id: deviceId, factory: { ownerId } },
      select: { id: true, name: true, factoryId: true },
    });
  },

  setRuntimeStatus(db: Db, deviceIds: readonly string[], runtimeStatus: RuntimeState) {
    return db.deviceInstance.updateMany({ where: { id: { in: [...deviceIds] } }, data: { runtimeStatus } });
  },

  /** Stores the latest important state of each device; one row per device, overwritten. */
  async saveSnapshots(
    db: Db,
    snapshots: ReadonlyArray<{
      deviceInstanceId: string;
      status: RuntimeState;
      quality: TagQuality;
      valuesJson: Prisma.InputJsonObject;
    }>,
    capturedAt: Date,
  ): Promise<void> {
    for (const snapshot of snapshots) {
      const { deviceInstanceId, ...values } = snapshot;
      await db.deviceRuntimeSnapshot.upsert({
        where: { deviceInstanceId },
        create: { deviceInstanceId, ...values, capturedAt },
        update: { ...values, capturedAt },
      });
    }
  },
};
