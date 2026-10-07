-- CreateEnum
CREATE TYPE "PlcEventKind" AS ENUM ('PLC_STATE', 'TAG_QUALITY');

-- CreateTable
CREATE TABLE "TagLatest" (
    "plcId" UUID NOT NULL,
    "tag" TEXT NOT NULL,
    "valueNum" DOUBLE PRECISION,
    "valueBool" BOOLEAN,
    "quality" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "configVersion" INTEGER NOT NULL,

    CONSTRAINT "TagLatest_pkey" PRIMARY KEY ("plcId","tag")
);

-- CreateTable
CREATE TABLE "PlcEvent" (
    "id" UUID NOT NULL,
    "plcId" UUID NOT NULL,
    "kind" "PlcEventKind" NOT NULL,
    "subject" TEXT NOT NULL,
    "fromValue" TEXT,
    "toValue" TEXT NOT NULL,
    "at" TIMESTAMP(3) NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PlcEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PlcEvent_plcId_at_idx" ON "PlcEvent"("plcId", "at");

-- CreateIndex
CREATE UNIQUE INDEX "PlcEvent_plcId_kind_subject_at_key" ON "PlcEvent"("plcId", "kind", "subject", "at");

-- AddForeignKey
ALTER TABLE "TagLatest" ADD CONSTRAINT "TagLatest_plcId_fkey" FOREIGN KEY ("plcId") REFERENCES "Plc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcEvent" ADD CONSTRAINT "PlcEvent_plcId_fkey" FOREIGN KEY ("plcId") REFERENCES "Plc"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Telemetry history (TASK-903, ADR-0020). A schema of its own, outside the Prisma schema:
-- Prisma neither models nor diffs it. Both tables are partitioned by day (UTC); Web
-- Factory creates the day partitions it needs and drops those older than the retention
-- (lib/telemetry/store.ts), so there are no partitions here.
CREATE SCHEMA IF NOT EXISTS telemetry;

-- One row per received poll of a PLC: the key that makes a redelivered or replayed batch
-- a duplicate, and what was learned when it arrived.
CREATE TABLE telemetry.batch (
    plc_id UUID NOT NULL,
    at TIMESTAMPTZ NOT NULL,
    received_at TIMESTAMPTZ NOT NULL,
    config_version INTEGER NOT NULL,
    replayed BOOLEAN NOT NULL,
    value_count INTEGER NOT NULL,
    PRIMARY KEY (plc_id, at)
) PARTITION BY RANGE (at);

-- One row per tag per poll. `tag` is the tag's external id (PlcMapping.externalId).
CREATE TABLE telemetry.sample (
    plc_id UUID NOT NULL,
    tag TEXT NOT NULL,
    at TIMESTAMPTZ NOT NULL,
    value_num DOUBLE PRECISION,
    value_bool BOOLEAN,
    quality TEXT NOT NULL,
    PRIMARY KEY (plc_id, tag, at)
) PARTITION BY RANGE (at);
