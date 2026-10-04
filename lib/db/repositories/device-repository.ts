import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { DeviceInstance, RuntimeType, SimulatorType } from "@/lib/generated/prisma/client";

const modelWithCategory = {
  family: { include: { category: true } },
} as const;

export type NewDeviceInstance = {
  factoryId: string;
  deviceModelId: string;
  name: string;
  role?: string;
  location?: string;
  runtimeType: RuntimeType;
  simulatorType: SimulatorType;
};

export const deviceRepository = {
  /** Catalog model with the category that decides how its instances behave. */
  findModel(db: Db, deviceModelId: string) {
    return db.deviceModel.findUnique({ where: { id: deviceModelId }, include: modelWithCategory });
  },

  factoryExists(db: Db, factoryId: string): Promise<boolean> {
    return db.factory.count({ where: { id: factoryId } }).then((count) => count > 0);
  },

  createInstance(db: Db, data: NewDeviceInstance): Promise<DeviceInstance> {
    return withDomainErrors(() => db.deviceInstance.create({ data }));
  },

  createPlcProfile(db: Db, deviceInstanceId: string) {
    return withDomainErrors(() => db.plcInstanceProfile.create({ data: { deviceInstanceId } }));
  },

  /** Instance with its catalog model and category, as needed to validate relationships. */
  findInstance(db: Db, id: string) {
    return db.deviceInstance.findUnique({
      where: { id },
      include: { deviceModel: { include: { family: { include: { category: true } } } } },
    });
  },

  listByFactory(db: Db, factoryId: string): Promise<DeviceInstance[]> {
    return db.deviceInstance.findMany({ where: { factoryId }, orderBy: { name: "asc" } });
  },
};
