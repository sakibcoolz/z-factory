import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import { GATEWAY_CATEGORY_CODES } from "@/lib/domain/gateway";
import type { AccessMode, Prisma } from "@/lib/generated/prisma/client";

const connectionInclude = {
  gateway: { include: { deviceInstance: { select: { id: true, name: true, factoryId: true } } } },
  plc: { include: { deviceInstance: { select: { id: true, name: true, runtimeStatus: true } } } },
  tagMappings: { include: { tag: true }, orderBy: { externalName: "asc" } },
} satisfies Prisma.GatewayPlcConnectionInclude;

export type GatewayConnectionRecord = NonNullable<Awaited<ReturnType<typeof gatewayRepository.findConnection>>>;

/** External gateways of a factory: their device instances, PLC connections and tag mappings. */
export const gatewayRepository = {
  /** A gateway device of one of the owner's factories. */
  findGatewayDevice(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({
      where: {
        id: deviceId,
        factory: { ownerId },
        deviceModel: { family: { category: { code: { in: [...GATEWAY_CATEGORY_CODES] } } } },
      },
      include: { gateway: true },
    });
  },

  /** Every gateway device of a factory with its connections, in name order. */
  listGatewayDevices(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId, deviceModel: { family: { category: { code: { in: [...GATEWAY_CATEGORY_CODES] } } } } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        deviceModel: { select: { modelName: true } },
        gateway: { select: { id: true, plcConnections: { include: connectionInclude, orderBy: { port: "asc" } } } },
      },
    });
  },

  /** The PLCs of a factory with the tags a gateway could be given. */
  listPlcs(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId, plcProfile: { isNot: null } },
      orderBy: { name: "asc" },
      select: {
        id: true,
        name: true,
        runtimeStatus: true,
        plcProfile: { select: { tags: { where: { protocolArea: { not: null } }, orderBy: { name: "asc" } } } },
      },
    });
  },

  /** The first catalog model a new gateway device can be created from. */
  findGatewayModel(db: Db) {
    return db.deviceModel.findFirst({
      where: { family: { category: { code: { in: [...GATEWAY_CATEGORY_CODES] } } } },
      orderBy: [{ family: { category: { code: "desc" } } }, { modelName: "asc" }],
      select: { id: true },
    });
  },

  ensureGateway(db: Db, device: { id: string; name: string; factoryId: string }) {
    return withDomainErrors(() =>
      db.gateway.upsert({
        where: { deviceInstanceId: device.id },
        create: { deviceInstanceId: device.id, factoryId: device.factoryId, name: device.name },
        update: {},
      }),
    );
  },

  createConnection(
    db: Db,
    data: {
      gatewayId: string;
      plcInstanceId: string;
      host: string;
      port: number;
      unitId: number;
      pollIntervalMs: number;
    },
  ) {
    return withDomainErrors(() => db.gatewayPlcConnection.create({ data: { ...data, protocol: "MODBUS_TCP" } }));
  },

  findConnection(db: Db, ownerId: string, connectionId: string) {
    return db.gatewayPlcConnection.findFirst({
      where: { id: connectionId, gateway: { factory: { ownerId } } },
      include: connectionInclude,
    });
  },

  listConnections(db: Db, factoryId: string) {
    return db.gatewayPlcConnection.findMany({ where: { gateway: { factoryId } }, include: connectionInclude });
  },

  /** Every address a gateway endpoint is configured on, in any factory: they share the host. */
  listEndpoints(db: Db): Promise<Array<{ id: string; host: string; port: number }>> {
    return db.gatewayPlcConnection.findMany({ select: { id: true, host: true, port: true } });
  },

  setEnabled(db: Db, connectionId: string, enabled: boolean) {
    return db.gatewayPlcConnection.update({ where: { id: connectionId }, data: { enabled } });
  },

  deleteConnection(db: Db, connectionId: string) {
    return db.gatewayPlcConnection.delete({ where: { id: connectionId } });
  },

  findTag(db: Db, plcInstanceId: string, tagId: string) {
    return db.tag.findFirst({ where: { id: tagId, plcInstanceId } });
  },

  upsertMapping(
    db: Db,
    data: { gatewayPlcConnectionId: string; tagId: string; externalName: string; accessMode: AccessMode },
  ) {
    const { gatewayPlcConnectionId, tagId, ...values } = data;
    return withDomainErrors(() =>
      db.gatewayTagMapping.upsert({
        where: { gatewayPlcConnectionId_tagId: { gatewayPlcConnectionId, tagId } },
        create: data,
        update: values,
      }),
    );
  },

  deleteMapping(db: Db, connectionId: string, mappingId: string) {
    return db.gatewayTagMapping.deleteMany({ where: { id: mappingId, gatewayPlcConnectionId: connectionId } });
  },

  setGatewayStatus(db: Db, gatewayId: string, status: "RUNNING" | "STOPPED" | "FAULTED") {
    return db.gateway.update({ where: { id: gatewayId }, data: { status } });
  },
};
