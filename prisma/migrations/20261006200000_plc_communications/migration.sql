-- CreateEnum
CREATE TYPE "PlcRelationship" AS ENUM ('COMMUNICATES_WITH', 'SUPERVISES');

-- AlterEnum
ALTER TYPE "ConfigurationScope" ADD VALUE 'PLC_COMMUNICATION';

-- CreateTable
CREATE TABLE "PlcCommunicationConnection" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "sourcePlcInstanceId" UUID NOT NULL,
    "targetPlcInstanceId" UUID NOT NULL,
    "relationship" "PlcRelationship" NOT NULL,
    "protocol" "Protocol" NOT NULL DEFAULT 'MODBUS_TCP',
    "clientPlcInstanceId" UUID NOT NULL,
    "serverPlcInstanceId" UUID NOT NULL,
    "serverHost" TEXT NOT NULL,
    "serverPort" INTEGER NOT NULL DEFAULT 502,
    "unitId" INTEGER NOT NULL DEFAULT 1,
    "pollIntervalMs" INTEGER NOT NULL DEFAULT 1000,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "configVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PlcCommunicationConnection_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlcCommunicationConnection_factoryId_idx" ON "PlcCommunicationConnection"("factoryId");

-- CreateIndex
CREATE UNIQUE INDEX "PlcCommunicationConnection_sourcePlcInstanceId_targetPlcIns_key" ON "PlcCommunicationConnection"("sourcePlcInstanceId", "targetPlcInstanceId", "protocol");

-- AddForeignKey
ALTER TABLE "PlcCommunicationConnection" ADD CONSTRAINT "PlcCommunicationConnection_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcCommunicationConnection" ADD CONSTRAINT "PlcCommunicationConnection_sourcePlcInstanceId_fkey" FOREIGN KEY ("sourcePlcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcCommunicationConnection" ADD CONSTRAINT "PlcCommunicationConnection_targetPlcInstanceId_fkey" FOREIGN KEY ("targetPlcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;


-- A link joins two different PLCs; its client and server are those two PLCs, one each.
ALTER TABLE "PlcCommunicationConnection"
  ADD CONSTRAINT "PlcCommunicationConnection_distinct_plcs_check"
  CHECK ("sourcePlcInstanceId" <> "targetPlcInstanceId");
ALTER TABLE "PlcCommunicationConnection"
  ADD CONSTRAINT "PlcCommunicationConnection_roles_check"
  CHECK (
    "clientPlcInstanceId" <> "serverPlcInstanceId"
    AND "clientPlcInstanceId" IN ("sourcePlcInstanceId", "targetPlcInstanceId")
    AND "serverPlcInstanceId" IN ("sourcePlcInstanceId", "targetPlcInstanceId")
  );
ALTER TABLE "PlcCommunicationConnection"
  ADD CONSTRAINT "PlcCommunicationConnection_endpoint_check"
  CHECK ("serverPort" BETWEEN 1 AND 65535 AND "unitId" BETWEEN 0 AND 255 AND "pollIntervalMs" BETWEEN 50 AND 60000);
