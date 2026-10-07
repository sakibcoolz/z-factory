-- AlterTable
ALTER TABLE "EdgeAgent" ADD COLUMN     "agentVersion" TEXT,
ADD COLUMN     "brokerClientId" TEXT,
ADD COLUMN     "brokerUsername" TEXT,
ADD COLUMN     "credentialIssuedAt" TIMESTAMP(3),
ADD COLUMN     "credentialRevokedAt" TIMESTAMP(3),
ADD COLUMN     "heartbeatJson" JSONB,
ADD COLUMN     "lastHeartbeatAt" TIMESTAMP(3),
ADD COLUMN     "statusAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Plc" ADD COLUMN     "edgeConfigVersion" INTEGER,
ADD COLUMN     "edgeLastError" TEXT,
ADD COLUMN     "edgeLastPollAt" TIMESTAMP(3),
ADD COLUMN     "edgeReconnects" INTEGER,
ADD COLUMN     "edgeState" TEXT,
ADD COLUMN     "edgeStateAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "AgentConnectionEvent" (
    "id" UUID NOT NULL,
    "edgeAgentId" UUID NOT NULL,
    "status" "AgentStatus" NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AgentConnectionEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AgentConnectionEvent_edgeAgentId_at_idx" ON "AgentConnectionEvent"("edgeAgentId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "AgentConnectionEvent_edgeAgentId_status_at_key" ON "AgentConnectionEvent"("edgeAgentId", "status", "at");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeAgent_brokerUsername_key" ON "EdgeAgent"("brokerUsername");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeAgent_brokerClientId_key" ON "EdgeAgent"("brokerClientId");

-- AddForeignKey
ALTER TABLE "AgentConnectionEvent" ADD CONSTRAINT "AgentConnectionEvent_edgeAgentId_fkey" FOREIGN KEY ("edgeAgentId") REFERENCES "EdgeAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

