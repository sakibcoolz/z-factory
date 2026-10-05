-- AlterTable
ALTER TABLE "Tag" ADD COLUMN     "sourceSignal" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "Tag_sourceDeviceInstanceId_sourceSignal_key" ON "Tag"("sourceDeviceInstanceId", "sourceSignal");

