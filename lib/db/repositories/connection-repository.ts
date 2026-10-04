import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { ConnectionRelationship, DeviceConnection, EndpointType, Protocol } from "@/lib/generated/prisma/client";

export type NewConnection = {
  factoryId: string;
  sourceDeviceId: string;
  targetDeviceId: string;
  sourceEndpointType: EndpointType;
  sourceEndpointRef: string;
  targetEndpointType: EndpointType;
  targetEndpointRef: string;
  relationship: ConnectionRelationship;
  protocol?: Protocol;
};

export const connectionRepository = {
  create(db: Db, data: NewConnection): Promise<DeviceConnection> {
    return withDomainErrors(() => db.deviceConnection.create({ data }));
  },

  listByFactory(db: Db, factoryId: string): Promise<DeviceConnection[]> {
    return db.deviceConnection.findMany({ where: { factoryId }, orderBy: { createdAt: "asc" } });
  },

  countDrivesFrom(db: Db, sourceDeviceId: string): Promise<number> {
    return db.deviceConnection.count({ where: { sourceDeviceId, relationship: "DRIVES" } });
  },

  countDrivesInto(db: Db, targetDeviceId: string): Promise<number> {
    return db.deviceConnection.count({ where: { targetDeviceId, relationship: "DRIVES" } });
  },

  /** PLC I/O point with the catalog channel that defines its type and signal. */
  findIoPoint(db: Db, id: string) {
    return db.plcIoPoint.findUnique({ where: { id }, include: { builtInChannel: true, moduleChannel: true } });
  },

  findDeviceIoDefinition(db: Db, id: string) {
    return db.deviceIoDefinition.findUnique({ where: { id } });
  },

  markIoPointOccupied(db: Db, id: string) {
    return withDomainErrors(() => db.plcIoPoint.update({ where: { id }, data: { status: "OCCUPIED" } }));
  },
};
