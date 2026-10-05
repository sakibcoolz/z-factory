-- AlterTable
ALTER TABLE "Catalog3dAsset" ADD COLUMN     "generationJson" JSONB,
ADD COLUMN     "providerStatus" TEXT,
ADD COLUMN     "statusMessage" TEXT;
