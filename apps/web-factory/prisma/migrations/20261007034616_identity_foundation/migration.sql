-- CreateEnum
CREATE TYPE "Role" AS ENUM ('VIEWER', 'OPERATOR', 'ADMIN');

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('ACTIVE', 'DISABLED');

-- CreateEnum
CREATE TYPE "AgentStatus" AS ENUM ('UNKNOWN', 'ONLINE', 'OFFLINE');

-- CreateEnum
CREATE TYPE "MappingAccess" AS ENUM ('READ', 'WRITE');

-- CreateTable
CREATE TABLE "Organization" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "status" "UserStatus" NOT NULL DEFAULT 'ACTIVE',
    "sessionVersion" INTEGER NOT NULL DEFAULT 0,
    "failedLogins" INTEGER NOT NULL DEFAULT 0,
    "lockedUntil" TIMESTAMP(3),
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Site" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Site_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EdgeAgent" (
    "id" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "agentKey" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" "AgentStatus" NOT NULL DEFAULT 'UNKNOWN',
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EdgeAgent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Factory" (
    "id" UUID NOT NULL,
    "organizationId" UUID NOT NULL,
    "siteId" UUID NOT NULL,
    "externalFactoryId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Factory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Plc" (
    "id" UUID NOT NULL,
    "edgeAgentId" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "externalPlcId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "configVersion" INTEGER NOT NULL,
    "checksum" TEXT NOT NULL,
    "deploymentJson" JSONB NOT NULL,
    "registeredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Plc_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlcMapping" (
    "id" UUID NOT NULL,
    "plcId" UUID NOT NULL,
    "externalId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "access" "MappingAccess" NOT NULL,
    "role" TEXT NOT NULL,
    "dataType" TEXT NOT NULL,
    "unit" TEXT,
    "min" DOUBLE PRECISION,
    "max" DOUBLE PRECISION,

    CONSTRAINT "PlcMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Module" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "externalModuleId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Module_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlcModule" (
    "plcId" UUID NOT NULL,
    "moduleId" UUID NOT NULL,

    CONSTRAINT "PlcModule_pkey" PRIMARY KEY ("plcId","moduleId")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "organizationId" UUID,
    "actorUserId" UUID,
    "action" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT,
    "detailJson" JSONB NOT NULL DEFAULT '{}',
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Organization_slug_key" ON "Organization"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_organizationId_userId_key" ON "Membership"("organizationId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "Site_siteKey_key" ON "Site"("siteKey");

-- CreateIndex
CREATE INDEX "Site_organizationId_idx" ON "Site"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "EdgeAgent_siteId_agentKey_key" ON "EdgeAgent"("siteId", "agentKey");

-- CreateIndex
CREATE INDEX "Factory_organizationId_idx" ON "Factory"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "Factory_siteId_externalFactoryId_key" ON "Factory"("siteId", "externalFactoryId");

-- CreateIndex
CREATE INDEX "Plc_factoryId_idx" ON "Plc"("factoryId");

-- CreateIndex
CREATE UNIQUE INDEX "Plc_edgeAgentId_externalPlcId_key" ON "Plc"("edgeAgentId", "externalPlcId");

-- CreateIndex
CREATE UNIQUE INDEX "PlcMapping_plcId_externalId_key" ON "PlcMapping"("plcId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "PlcMapping_plcId_name_key" ON "PlcMapping"("plcId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Module_factoryId_externalModuleId_key" ON "Module"("factoryId", "externalModuleId");

-- CreateIndex
CREATE INDEX "AuditEvent_organizationId_at_idx" ON "AuditEvent"("organizationId", "at");

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Site" ADD CONSTRAINT "Site_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EdgeAgent" ADD CONSTRAINT "EdgeAgent_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Factory" ADD CONSTRAINT "Factory_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Factory" ADD CONSTRAINT "Factory_siteId_fkey" FOREIGN KEY ("siteId") REFERENCES "Site"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plc" ADD CONSTRAINT "Plc_edgeAgentId_fkey" FOREIGN KEY ("edgeAgentId") REFERENCES "EdgeAgent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Plc" ADD CONSTRAINT "Plc_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcMapping" ADD CONSTRAINT "PlcMapping_plcId_fkey" FOREIGN KEY ("plcId") REFERENCES "Plc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Module" ADD CONSTRAINT "Module_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcModule" ADD CONSTRAINT "PlcModule_plcId_fkey" FOREIGN KEY ("plcId") REFERENCES "Plc"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcModule" ADD CONSTRAINT "PlcModule_moduleId_fkey" FOREIGN KEY ("moduleId") REFERENCES "Module"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_actorUserId_fkey" FOREIGN KEY ("actorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
