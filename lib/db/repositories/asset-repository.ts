import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { Catalog3dAssetStatus, Prisma } from "@/lib/generated/prisma/client";

const authoringSelect = {
  id: true,
  modelName: true,
  sku: true,
  architectureType: true,
  verificationStatus: true,
  active3dAssetId: true,
  family: {
    select: {
      name: true,
      manufacturer: { select: { name: true } },
      category: { select: { code: true, name: true } },
    },
  },
  assets3d: { orderBy: { version: "desc" } },
} satisfies Prisma.DeviceModelSelect;

/** Catalog 3D assets and how factory instances are placed in the 3D view. */
export const assetRepository = {
  findModel(db: Db, deviceModelId: string) {
    return db.deviceModel.findUnique({ where: { id: deviceModelId }, select: { id: true, modelName: true } });
  },

  async nextVersion(db: Db, deviceModelId: string): Promise<number> {
    const latest = await db.catalog3dAsset.aggregate({ where: { deviceModelId }, _max: { version: true } });
    return (latest._max.version ?? 0) + 1;
  },

  create(
    db: Db,
    data: {
      deviceModelId: string;
      version: number;
      status: Catalog3dAssetStatus;
      storageKey: string;
      contentSha256: string;
      sizeBytes: number;
      provider: string;
      providerJobId: string | null;
      scale: number | null;
      rotationYDeg: number;
      boundsJson: Prisma.InputJsonObject | undefined;
      validationJson: Prisma.InputJsonObject;
      generationJson?: Prisma.InputJsonObject;
    },
  ) {
    return withDomainErrors(() => db.catalog3dAsset.create({ data }));
  },

  findById(db: Db, assetId: string) {
    return db.catalog3dAsset.findUnique({ where: { id: assetId } });
  },

  /** A version that is asked for but has no file yet: a generation job in progress. */
  createPending(
    db: Db,
    data: {
      deviceModelId: string;
      version: number;
      provider: string;
      statusMessage: string | null;
      generationJson: Prisma.InputJsonObject | undefined;
    },
  ) {
    return withDomainErrors(() => db.catalog3dAsset.create({ data: { ...data, status: "PENDING" } }));
  },

  update(db: Db, assetId: string, data: Prisma.Catalog3dAssetUncheckedUpdateInput) {
    return withDomainErrors(() => db.catalog3dAsset.update({ where: { id: assetId }, data }));
  },

  findPending(db: Db, deviceModelId: string) {
    return db.catalog3dAsset.findFirst({ where: { deviceModelId, status: "PENDING" }, orderBy: { version: "desc" } });
  },

  /** The newest version that can be rendered, optionally other than one being retired. */
  latestReady(db: Db, deviceModelId: string, exceptId?: string) {
    return db.catalog3dAsset.findFirst({
      where: { deviceModelId, status: "READY", ...(exceptId ? { id: { not: exceptId } } : {}) },
      orderBy: { version: "desc" },
    });
  },

  /** What a prompt and a footprint are derived from: the model's kind, never its instances. */
  findModelForAuthoring(db: Db, deviceModelId: string) {
    return db.deviceModel.findUnique({ where: { id: deviceModelId }, select: authoringSelect });
  },

  listModelsForAuthoring(db: Db) {
    return db.deviceModel.findMany({
      select: authoringSelect,
      orderBy: [{ family: { category: { code: "asc" } } }, { modelName: "asc" }],
    });
  },

  /** Every asset version in the catalog, newest first per model: for the catalog's status column. */
  listAll(db: Db) {
    return db.catalog3dAsset.findMany({ orderBy: [{ deviceModelId: "asc" }, { version: "desc" }] });
  },

  listForModel(db: Db, deviceModelId: string) {
    return db.catalog3dAsset.findMany({ where: { deviceModelId }, orderBy: { version: "desc" } });
  },

  /** Makes one version the asset every instance of the model renders. */
  setActive(db: Db, deviceModelId: string, assetId: string | null) {
    return db.deviceModel.update({ where: { id: deviceModelId }, data: { active3dAssetId: assetId } });
  },

  /** What the scene needs beyond the topology: each device's model, asset and placing. */
  listSceneDevices(db: Db, factoryId: string) {
    return db.deviceInstance.findMany({
      where: { factoryId },
      select: {
        id: true,
        sceneRotationDeg: true,
        sceneScale: true,
        deviceModel: { select: { id: true, active3dAsset: true } },
      },
    });
  },

  findDeviceForOwner(db: Db, ownerId: string, deviceId: string) {
    return db.deviceInstance.findFirst({
      where: { id: deviceId, factory: { ownerId } },
      select: { id: true, factoryId: true, sceneRotationDeg: true, sceneScale: true },
    });
  },

  setSceneTransform(db: Db, deviceId: string, data: { sceneRotationDeg: number; sceneScale: number }) {
    return withDomainErrors(() => db.deviceInstance.update({ where: { id: deviceId }, data }));
  },
};
