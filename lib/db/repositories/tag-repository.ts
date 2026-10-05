import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { Prisma, Tag } from "@/lib/generated/prisma/client";

export const tagRepository = {
  listByPlc(db: Db, plcInstanceId: string): Promise<Tag[]> {
    return db.tag.findMany({
      where: { plcInstanceId },
      orderBy: [{ protocolArea: "asc" }, { protocolAddress: "asc" }],
    });
  },

  /** The PLC's tags in address order, each with the name of the device it is wired to. */
  listWithSourceDevice(db: Db, plcInstanceId: string) {
    return db.tag.findMany({
      where: { plcInstanceId },
      include: { sourceDevice: { select: { name: true } } },
      orderBy: [{ logicalAddress: "asc" }, { name: "asc" }],
    });
  },

  findByName(db: Db, plcInstanceId: string, name: string): Promise<Tag | null> {
    return db.tag.findUnique({ where: { plcInstanceId_name: { plcInstanceId, name } } });
  },

  create(db: Db, data: Prisma.TagUncheckedCreateInput): Promise<Tag> {
    return withDomainErrors(() => db.tag.create({ data }));
  },

  async delete(db: Db, plcInstanceId: string, name: string): Promise<number> {
    const result = await db.tag.deleteMany({ where: { plcInstanceId, name } });
    return result.count;
  },

  /** The device, when it is an instance of the given factory. */
  findDeviceInFactory(db: Db, deviceId: string, factoryId: string) {
    return db.deviceInstance.findFirst({
      where: { id: deviceId, factoryId },
      select: { id: true, name: true, simulatorType: true, runtimeType: true },
    });
  },

  /** The PLC's I/O point at a located address, if that address belongs to one. */
  findIoPointByAddress(db: Db, plcInstanceId: string, logicalAddress: string) {
    return db.plcIoPoint.findUnique({
      where: { plcInstanceId_logicalAddress: { plcInstanceId, logicalAddress } },
      select: { id: true },
    });
  },

  /** The tag already wired to a device signal, if any. */
  findBySignal(db: Db, sourceDeviceInstanceId: string, sourceSignal: string): Promise<Tag | null> {
    return db.tag.findFirst({ where: { sourceDeviceInstanceId, sourceSignal } });
  },

  /** True when the device is an instance of the given factory. */
  async deviceInFactory(db: Db, deviceId: string, factoryId: string): Promise<boolean> {
    return (await db.deviceInstance.count({ where: { id: deviceId, factoryId } })) > 0;
  },

  recordCommand(
    db: Db,
    command: {
      factoryId: string;
      plcInstanceId: string;
      tagId: string;
      targetDeviceId: string | null;
      requestedValueJson: Prisma.InputJsonValue;
      source: "UI" | "GATEWAY" | "SYSTEM";
    },
  ) {
    return db.deviceCommand.create({ data: { ...command, commandType: "WRITE_TAG" } });
  },

  setCommandStatus(db: Db, commandId: string, status: "ACCEPTED" | "FAILED" | "REJECTED") {
    return db.deviceCommand.update({ where: { id: commandId }, data: { status } });
  },
};
