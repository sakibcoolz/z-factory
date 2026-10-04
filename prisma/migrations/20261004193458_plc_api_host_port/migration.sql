-- AlterTable
ALTER TABLE "PlcInstanceProfile" ADD COLUMN     "apiHostPort" INTEGER;

-- CreateIndex
CREATE UNIQUE INDEX "PlcInstanceProfile_apiHostPort_key" ON "PlcInstanceProfile"("apiHostPort");

