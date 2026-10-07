-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('REQUESTED', 'PUBLISHED', 'ACCEPTED', 'REJECTED', 'APPLIED', 'FAILED', 'TIMED_OUT');

-- CreateTable
CREATE TABLE "Command" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentId" UUID NOT NULL,
    "plcId" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "tagName" TEXT NOT NULL,
    "valueNum" DOUBLE PRECISION,
    "valueBool" BOOLEAN,
    "configVersion" INTEGER NOT NULL,
    "requestedBy" UUID NOT NULL,
    "requestKey" TEXT NOT NULL,
    "status" "CommandStatus" NOT NULL DEFAULT 'REQUESTED',
    "rule" TEXT,
    "reason" TEXT,
    "observedJson" JSONB,
    "duplicateAcks" INTEGER NOT NULL DEFAULT 0,
    "lateAnswer" BOOLEAN NOT NULL DEFAULT false,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "publishedAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Command_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Command_plcId_requestedAt_idx" ON "Command"("plcId", "requestedAt");

-- CreateIndex
CREATE INDEX "Command_organizationId_requestedAt_idx" ON "Command"("organizationId", "requestedAt");

-- CreateIndex
CREATE INDEX "Command_status_expiresAt_idx" ON "Command"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "Command_requestedBy_requestKey_key" ON "Command"("requestedBy", "requestKey");

-- AddForeignKey
ALTER TABLE "Command" ADD CONSTRAINT "Command_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

