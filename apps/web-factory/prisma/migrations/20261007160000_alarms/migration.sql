-- CreateEnum
CREATE TYPE "AlarmSource" AS ENUM ('PLC_TAG', 'PLC_CONNECTION', 'AGENT_CONNECTION');

-- CreateEnum
CREATE TYPE "AlarmSeverity" AS ENUM ('HIGH', 'MEDIUM', 'LOW');

-- CreateTable
CREATE TABLE "Alarm" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentId" UUID,
    "plcId" UUID,
    "source" "AlarmSource" NOT NULL,
    "subject" TEXT NOT NULL,
    "severity" "AlarmSeverity" NOT NULL,
    "message" TEXT NOT NULL,
    "activeKey" TEXT,
    "raisedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),
    "acknowledgedBy" UUID,

    CONSTRAINT "Alarm_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Alarm_activeKey_key" ON "Alarm"("activeKey");

-- CreateIndex
CREATE INDEX "Alarm_organizationId_raisedAt_idx" ON "Alarm"("organizationId", "raisedAt");

-- CreateIndex
CREATE INDEX "Alarm_plcId_raisedAt_idx" ON "Alarm"("plcId", "raisedAt");

-- CreateIndex
CREATE INDEX "Alarm_agentId_raisedAt_idx" ON "Alarm"("agentId", "raisedAt");

-- AddForeignKey
ALTER TABLE "Alarm" ADD CONSTRAINT "Alarm_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

