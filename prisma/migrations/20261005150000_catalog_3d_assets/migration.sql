-- CreateEnum
CREATE TYPE "Catalog3dAssetStatus" AS ENUM ('PENDING', 'READY', 'FAILED', 'RETIRED');

-- AlterTable
ALTER TABLE "DeviceInstance" ADD COLUMN     "sceneRotationDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
ADD COLUMN     "sceneScale" DOUBLE PRECISION NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "DeviceModel" ADD COLUMN     "active3dAssetId" UUID;

-- CreateTable
CREATE TABLE "Catalog3dAsset" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "status" "Catalog3dAssetStatus" NOT NULL DEFAULT 'PENDING',
    "storageKey" TEXT,
    "contentSha256" TEXT,
    "sizeBytes" INTEGER,
    "provider" TEXT NOT NULL,
    "providerJobId" TEXT,
    "scale" DOUBLE PRECISION,
    "rotationYDeg" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "boundsJson" JSONB,
    "validationJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Catalog3dAsset_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Catalog3dAsset_deviceModelId_version_key" ON "Catalog3dAsset"("deviceModelId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_active3dAssetId_key" ON "DeviceModel"("active3dAssetId");

-- AddForeignKey
ALTER TABLE "DeviceModel" ADD CONSTRAINT "DeviceModel_active3dAssetId_fkey" FOREIGN KEY ("active3dAssetId") REFERENCES "Catalog3dAsset"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Catalog3dAsset" ADD CONSTRAINT "Catalog3dAsset_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- CHECK constraints are not part of the Prisma schema; keep this block in sync with
-- docs/database.md → Database-enforced invariants.
ALTER TABLE "Catalog3dAsset" ADD CONSTRAINT "Catalog3dAsset_version_check" CHECK ("version" > 0);
-- An asset that can be rendered has a stored, identified file.
ALTER TABLE "Catalog3dAsset" ADD CONSTRAINT "Catalog3dAsset_ready_file_check" CHECK (
  "status" <> 'READY' OR ("storageKey" IS NOT NULL AND "contentSha256" IS NOT NULL AND "sizeBytes" > 0)
);
ALTER TABLE "Catalog3dAsset" ADD CONSTRAINT "Catalog3dAsset_scale_check" CHECK ("scale" IS NULL OR "scale" > 0);
ALTER TABLE "DeviceInstance" ADD CONSTRAINT "DeviceInstance_scene_transform_check" CHECK (
  "sceneScale" >= 0.1 AND "sceneScale" <= 10 AND "sceneRotationDeg" >= 0 AND "sceneRotationDeg" < 360
);
