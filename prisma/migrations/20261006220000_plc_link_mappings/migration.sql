-- CreateEnum
CREATE TYPE "PlcLinkOperation" AS ENUM ('READ', 'WRITE');

-- CreateTable
CREATE TABLE "PlcCommunicationMapping" (
    "id" UUID NOT NULL,
    "plcCommunicationConnectionId" UUID NOT NULL,
    "operation" "PlcLinkOperation" NOT NULL,
    "localTagId" UUID NOT NULL,
    "remoteTagId" UUID NOT NULL,
    "updateIntervalMs" INTEGER,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlcCommunicationMapping_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlcCommunicationMapping_localTagId_idx" ON "PlcCommunicationMapping"("localTagId");

-- CreateIndex
CREATE INDEX "PlcCommunicationMapping_remoteTagId_idx" ON "PlcCommunicationMapping"("remoteTagId");

-- CreateIndex
CREATE UNIQUE INDEX "PlcCommunicationMapping_plcCommunicationConnectionId_localT_key" ON "PlcCommunicationMapping"("plcCommunicationConnectionId", "localTagId", "remoteTagId");

-- AddForeignKey
ALTER TABLE "PlcCommunicationMapping" ADD CONSTRAINT "PlcCommunicationMapping_plcCommunicationConnectionId_fkey" FOREIGN KEY ("plcCommunicationConnectionId") REFERENCES "PlcCommunicationConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcCommunicationMapping" ADD CONSTRAINT "PlcCommunicationMapping_localTagId_fkey" FOREIGN KEY ("localTagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcCommunicationMapping" ADD CONSTRAINT "PlcCommunicationMapping_remoteTagId_fkey" FOREIGN KEY ("remoteTagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- One writer per value (ADR-0015): a tag of the client is filled by at most one READ,
-- a command tag of the server is written by at most one WRITE, whatever the link.
CREATE UNIQUE INDEX "PlcCommunicationMapping_one_reader_per_local_tag"
  ON "PlcCommunicationMapping" ("localTagId") WHERE "operation" = 'READ';
CREATE UNIQUE INDEX "PlcCommunicationMapping_one_writer_per_remote_tag"
  ON "PlcCommunicationMapping" ("remoteTagId") WHERE "operation" = 'WRITE';
ALTER TABLE "PlcCommunicationMapping"
  ADD CONSTRAINT "PlcCommunicationMapping_distinct_tags_check" CHECK ("localTagId" <> "remoteTagId");
ALTER TABLE "PlcCommunicationMapping"
  ADD CONSTRAINT "PlcCommunicationMapping_interval_check"
  CHECK ("updateIntervalMs" IS NULL OR "updateIntervalMs" BETWEEN 50 AND 60000);
