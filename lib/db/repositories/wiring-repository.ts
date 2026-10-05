import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import { type ConnectionRelationship, type EndpointType, Prisma, type Protocol } from "@/lib/generated/prisma/client";

/** Endpoint types a wire can end on; a device-level relationship has none of them. */
const WIRE_ENDPOINTS: EndpointType[] = ["DEVICE_IO", "PLC_IO_POINT", "PROTOCOL_PORT"];

const wireInclude = {
  sourceDevice: { select: { id: true, name: true } },
  targetDevice: { select: { id: true, name: true } },
} as const satisfies Prisma.DeviceConnectionInclude;

const pointInclude = {
  builtInChannel: true,
  moduleChannel: true,
  factoryModule: { select: { slotIndex: true } },
  tag: { select: { name: true } },
} as const satisfies Prisma.PlcIoPointInclude;

export type WireRecord = Awaited<ReturnType<typeof wiringRepository.listWires>>[number];
export type WiringDeviceRecord = Awaited<ReturnType<typeof wiringRepository.findDevices>>[number];
export type WiringPointRecord = Awaited<ReturnType<typeof wiringRepository.listPointsOf>>[number];

/** Physical wiring: the endpoints of devices and the wires between them. */
export const wiringRepository = {
  /**
   * Holds the devices' rows for the rest of the transaction, in one order, so two wires
   * cannot both take an endpoint's last place.
   */
  lockDevices(db: Prisma.TransactionClient, deviceIds: readonly string[]) {
    const ids = [...new Set(deviceIds)].sort();
    return db.$queryRaw`
      SELECT "id" FROM "DeviceInstance" WHERE "id"::text IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE
    `;
  },

  /** Devices of one factory with the terminals and ports of their models. */
  findDevices(db: Db, factoryId: string, deviceIds: readonly string[]) {
    return db.deviceInstance.findMany({
      where: { factoryId, id: { in: [...deviceIds] } },
      select: {
        id: true,
        name: true,
        factoryId: true,
        deviceModel: {
          select: {
            runtimeSupport: true,
            architectureType: true,
            family: { select: { category: { select: { code: true, simulatorType: true } } } },
            ioDefinitions: { orderBy: [{ kind: "asc" }, { terminalLabel: "asc" }] },
            communicationPorts: { orderBy: { name: "asc" } },
          },
        },
      },
    });
  },

  /** Every I/O point of a PLC with its catalog channel. */
  listPointsOf(db: Db, plcIds: readonly string[]) {
    return db.plcIoPoint.findMany({ where: { plcInstanceId: { in: [...plcIds] } }, include: pointInclude });
  },

  listPoints(db: Db, ids: readonly string[]) {
    return db.plcIoPoint.findMany({ where: { id: { in: [...ids] } }, include: pointInclude });
  },

  listTerminals(db: Db, ids: readonly string[]) {
    return db.deviceIoDefinition.findMany({
      where: { id: { in: [...ids] } },
      select: { id: true, terminalLabel: true, kind: true },
    });
  },

  listPorts(db: Db, ids: readonly string[]) {
    return db.communicationPort.findMany({ where: { id: { in: [...ids] } }, select: { id: true, name: true } });
  },

  /** Wires with an end on one of the devices. */
  listWires(db: Db, deviceIds: readonly string[]) {
    const ids = [...deviceIds];
    return db.deviceConnection.findMany({
      where: {
        OR: [{ sourceDeviceId: { in: ids } }, { targetDeviceId: { in: ids } }],
        sourceEndpointType: { in: WIRE_ENDPOINTS },
        targetEndpointType: { in: WIRE_ENDPOINTS },
      },
      include: wireInclude,
      orderBy: { createdAt: "asc" },
    });
  },

  findWire(db: Db, factoryId: string, wireId: string) {
    return db.deviceConnection.findFirst({
      where: {
        id: wireId,
        factoryId,
        sourceEndpointType: { in: WIRE_ENDPOINTS },
        targetEndpointType: { in: WIRE_ENDPOINTS },
      },
      include: wireInclude,
    });
  },

  createWire(
    db: Db,
    data: {
      factoryId: string;
      sourceDeviceId: string;
      targetDeviceId: string;
      sourceEndpointType: EndpointType;
      sourceEndpointRef: string;
      targetEndpointType: EndpointType;
      targetEndpointRef: string;
      relationship: ConnectionRelationship;
      protocol?: Protocol;
    },
  ) {
    return withDomainErrors(() => db.deviceConnection.create({ data, select: { id: true } }));
  },

  deleteWire(db: Db, wireId: string) {
    return db.deviceConnection.delete({ where: { id: wireId } });
  },
};
