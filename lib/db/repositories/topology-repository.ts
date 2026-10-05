import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";

const deviceInclude = {
  deviceModel: {
    include: {
      family: { include: { category: true, manufacturer: true } },
      ioDefinitions: { select: { id: true } },
      communicationPorts: true,
    },
  },
} as const;

export type TopologyDeviceRecord = Awaited<ReturnType<typeof topologyRepository.listDevices>>[number];

export const topologyRepository = {
  listDevices(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({ where: { factoryId }, include: deviceInclude, orderBy: { createdAt: "asc" } });
  },

  findDevice(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({ where: { id: deviceId, factory: { ownerId } }, include: deviceInclude });
  },

  listConnections(db: Db, factoryId: string) {
    return db.deviceConnection.findMany({ where: { factoryId }, orderBy: { createdAt: "asc" } });
  },

  listConnectionsOf(db: Db, deviceId: string) {
    return db.deviceConnection.findMany({
      where: { OR: [{ sourceDeviceId: deviceId }, { targetDeviceId: deviceId }] },
    });
  },

  listTerminalLabels(db: Db, ids: readonly string[]) {
    return db.deviceIoDefinition.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, terminalLabel: true },
    });
  },

  listIoPoints(db: Db, ids: readonly string[]) {
    return db.plcIoPoint.findMany({
      where: { id: { in: [...ids] } },
      include: { builtInChannel: true, moduleChannel: true, tag: { select: { name: true } } },
    });
  },

  /** Every catalog model, for the palette. */
  listPaletteModels(db: Db) {
    return db.deviceModel.findMany({
      include: { family: { include: { category: true, manufacturer: true } } },
      orderBy: [{ family: { category: { name: "asc" } } }, { modelName: "asc" }],
    });
  },

  setPosition(db: Db, deviceId: string, x: number, y: number) {
    return db.deviceInstance.update({ where: { id: deviceId }, data: { canvasX: x, canvasY: y } });
  },

  rename(db: Db, deviceId: string, name: string, role: string | null) {
    return withDomainErrors(() => db.deviceInstance.update({ where: { id: deviceId }, data: { name, role } }));
  },
};
