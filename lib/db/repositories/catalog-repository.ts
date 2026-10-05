import "server-only";
import type { Db } from "@/lib/db/client";
import type { Prisma } from "@/lib/generated/prisma/client";

const modelInclude = {
  family: { include: { manufacturer: true, category: true, rackProfiles: { orderBy: { name: "asc" } } } },
  electricalProfile: true,
  communicationPorts: { orderBy: { name: "asc" } },
  builtInIoChannels: { orderBy: [{ ioType: "asc" }, { channelIndex: "asc" }] },
  ioDefinitions: { orderBy: { terminalLabel: "asc" } },
  moduleCompatibility: {
    include: { moduleModel: { include: { channels: { orderBy: [{ ioType: "asc" }, { channelIndex: "asc" }] } } } },
  },
  assets3d: { orderBy: { version: "desc" } },
} as const satisfies Prisma.DeviceModelInclude;

export type CatalogModelRecord = NonNullable<Awaited<ReturnType<typeof catalogRepository.findModel>>>;

export const catalogRepository = {
  /** Manufacturer › family › model, for the catalog tree. */
  listManufacturers(db: Db) {
    return db.manufacturer.findMany({
      orderBy: { name: "asc" },
      include: {
        families: {
          orderBy: { name: "asc" },
          include: {
            category: true,
            models: {
              orderBy: { modelName: "asc" },
              select: {
                id: true,
                modelName: true,
                sku: true,
                architectureType: true,
                verificationStatus: true,
                active3dAssetId: true,
                assets3d: { select: { id: true, version: true, status: true }, orderBy: { version: "desc" } },
              },
            },
          },
        },
      },
    });
  },

  findModel(db: Db, modelId: string) {
    return db.deviceModel.findUnique({ where: { id: modelId }, include: modelInclude });
  },

  /** Models a PLC can be connected to: everything with terminals or communication ports, except PLCs. */
  listPeripherals(db: Db) {
    return db.deviceModel.findMany({
      where: {
        family: { category: { code: { not: "PLC" } } },
        OR: [{ ioDefinitions: { some: {} } }, { communicationPorts: { some: {} } }],
      },
      include: {
        family: { include: { manufacturer: true, category: true } },
        ioDefinitions: { orderBy: { terminalLabel: "asc" } },
        communicationPorts: true,
      },
      orderBy: [{ family: { category: { name: "asc" } } }, { modelName: "asc" }],
    });
  },
};
