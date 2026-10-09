import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { IoPointSource, Prisma } from "@/lib/generated/prisma/client";

const channelOrder: Array<{ ioType: "asc" } | { channelIndex: "asc" }> = [{ ioType: "asc" }, { channelIndex: "asc" }];

const plcInclude = {
  factory: true,
  deviceModel: {
    include: {
      family: { include: { manufacturer: true, category: true, rackProfiles: { orderBy: { name: "asc" } } } },
      electricalProfile: true,
      communicationPorts: { orderBy: { name: "asc" } },
      builtInIoChannels: { orderBy: channelOrder },
      moduleCompatibility: { include: { moduleModel: { include: { channels: { orderBy: channelOrder } } } } },
    },
  },
  plcProfile: {
    include: {
      racks: {
        orderBy: { rackIndex: "asc" },
        include: { rackProfile: true, modules: { orderBy: { slotIndex: "asc" }, include: { moduleModel: true } } },
      },
      ioPoints: { include: { builtInChannel: true, moduleChannel: true, factoryModule: true, tag: true } },
    },
  },
} as const satisfies Prisma.DeviceInstanceInclude;

export type ConfigPlcRecord = NonNullable<Awaited<ReturnType<typeof plcConfigRepository.findPlc>>>;

export const plcConfigRepository = {
  /** A PLC of one of the owner's factories with its hardware, rack and I/O points. */
  findPlc(db: Db, ownerId: string, plcId: string) {
    return db.deviceInstance.findFirst({ where: { id: plcId, factory: { ownerId } }, include: plcInclude });
  },

  /** A PLC catalog model with what is needed to build an instance from it. */
  findPlcModel(db: Db, deviceModelId: string) {
    return db.deviceModel.findUnique({
      where: { id: deviceModelId },
      include: {
        family: { include: { category: true, rackProfiles: { orderBy: { name: "asc" } } } },
        builtInIoChannels: { orderBy: channelOrder },
      },
    });
  },

  findPeripheralModel(db: Db, deviceModelId: string) {
    return db.deviceModel.findUnique({
      where: { id: deviceModelId },
      include: {
        family: { include: { category: true, manufacturer: true } },
        // Signal terminals only: supply, 0 V and earth terminals are never wired to a PLC channel.
        ioDefinitions: { where: { kind: "SIGNAL" }, orderBy: { terminalLabel: "asc" } },
        communicationPorts: { orderBy: { name: "asc" } },
      },
    });
  },

  createRack(db: Db, plcInstanceId: string, rackProfileId: string) {
    return db.factoryRack.create({ data: { plcInstanceId, rackProfileId, rackIndex: 0 } });
  },

  createModule(db: Db, factoryRackId: string, moduleModelId: string, slotIndex: number) {
    return withDomainErrors(() => db.factoryModule.create({ data: { factoryRackId, moduleModelId, slotIndex } }));
  },

  deleteModule(db: Db, id: string) {
    return db.factoryModule.delete({ where: { id } });
  },

  createIoPoints(
    db: Db,
    points: Array<{
      plcInstanceId: string;
      sourceType: IoPointSource;
      builtInChannelId?: string;
      factoryModuleId?: string;
      moduleChannelId?: string;
      logicalAddress: string;
    }>,
  ) {
    return withDomainErrors(() => db.plcIoPoint.createMany({ data: points }));
  },

  /** Connections between a PLC and other devices, in either direction, with the other device. */
  listPlcConnections(db: Db, plcId: string) {
    const device = { include: { deviceModel: { include: { family: { include: { category: true } } } } } } as const;
    return db.deviceConnection.findMany({
      where: { OR: [{ sourceDeviceId: plcId }, { targetDeviceId: plcId }] },
      include: { sourceDevice: device, targetDevice: device },
      orderBy: { createdAt: "asc" },
    });
  },

  listTerminals(db: Db, ids: readonly string[]) {
    return db.deviceIoDefinition.findMany({ where: { id: { in: [...ids] } } });
  },

  listDeviceNames(db: Db, factoryId: string): Promise<string[]> {
    return db.deviceInstance
      .findMany({ where: { factoryId }, select: { name: true } })
      .then((rows) => rows.map((row) => row.name));
  },

  /** Addresses of tags that are not bound to an I/O point: new points must not land on them. */
  listFreeTagAddresses(db: Db, plcInstanceId: string): Promise<string[]> {
    return db.tag
      .findMany({
        where: { plcInstanceId, plcIoPointId: null, logicalAddress: { not: null } },
        select: { logicalAddress: true },
      })
      .then((rows) => rows.flatMap((row) => (row.logicalAddress ? [row.logicalAddress] : [])));
  },

  freeIoPoints(db: Db, ids: readonly string[]) {
    return db.plcIoPoint.updateMany({ where: { id: { in: [...ids] } }, data: { status: "FREE" } });
  },

  deleteTagsOfPoints(db: Db, ids: readonly string[]) {
    return db.tag.deleteMany({ where: { plcIoPointId: { in: [...ids] } } });
  },

  deleteConnections(db: Db, ids: readonly string[]) {
    return db.deviceConnection.deleteMany({ where: { id: { in: [...ids] } } });
  },

  deleteDevice(db: Db, id: string) {
    return db.deviceInstance.delete({ where: { id } });
  },

  bumpIoMappingVersion(db: Db, deviceInstanceId: string) {
    return db.plcInstanceProfile.update({ where: { deviceInstanceId }, data: { ioMappingVersion: { increment: 1 } } });
  },

  listFactoryDevices(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId },
      include: { deviceModel: { include: { family: { include: { category: true, manufacturer: true } } } } },
      orderBy: { name: "asc" },
    });
  },

  /** The PLCs of a factory with what the overview's LLM Context needs: program selected, I/O versions, point status. */
  listFactoryPlcProfiles(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId, plcProfile: { isNot: null } },
      select: {
        id: true,
        name: true,
        runtimeStatus: true,
        deviceModel: { select: { architectureType: true } },
        plcProfile: {
          select: { programVersionId: true, ioMappingVersion: true, ioPoints: { select: { status: true } } },
        },
      },
      orderBy: { name: "asc" },
    });
  },

  /** Which devices of a factory are connected: wiring and relationships, and a gateway with the PLC it reads. */
  async listFactoryLinks(
    db: Db,
    factoryId: string,
  ): Promise<Array<{ sourceId: string; targetId: string; weak: boolean }>> {
    const [connections, gateways] = await Promise.all([
      db.deviceConnection.findMany({
        where: { factoryId },
        select: { sourceDeviceId: true, targetDeviceId: true, relationship: true },
        distinct: ["sourceDeviceId", "targetDeviceId", "relationship"],
      }),
      db.gatewayPlcConnection.findMany({
        where: { gateway: { factoryId } },
        select: { plcInstanceId: true, gateway: { select: { deviceInstanceId: true } } },
      }),
    ]);
    return [
      ...connections.map((connection) => ({
        sourceId: connection.sourceDeviceId,
        targetId: connection.targetDeviceId,
        // What a sensor measures says where it looks, not what it belongs to.
        weak: connection.relationship === "MEASURES",
      })),
      ...gateways.map((connection) => ({
        sourceId: connection.gateway.deviceInstanceId,
        targetId: connection.plcInstanceId,
        weak: false,
      })),
    ];
  },

  /** PLC catalog models of one architecture, for the create form. */
  listPlcModels(db: Db, architectureType: "COMPACT" | "MODULAR") {
    return db.deviceModel.findMany({
      where: { architectureType, capabilities: { has: "PROGRAMMABLE" } },
      include: {
        family: { include: { manufacturer: true } },
        builtInIoChannels: { orderBy: channelOrder },
        communicationPorts: true,
        moduleCompatibility: { select: { id: true } },
      },
      orderBy: [{ family: { manufacturer: { name: "asc" } } }, { modelName: "asc" }],
    });
  },
};
