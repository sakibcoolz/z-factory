-- CreateEnum
CREATE TYPE "ModuleSignalDirection" AS ENUM ('INPUT', 'OUTPUT', 'INTERNAL', 'ALARM');

-- CreateTable
CREATE TABLE "ProcessModuleType" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "description" TEXT,
    "simulatorModelType" TEXT,
    "profiles" TEXT[],
    "configSchemaJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessModuleType_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleRoleDefinition" (
    "id" UUID NOT NULL,
    "processModuleTypeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "deviceCategoryCodes" TEXT[],
    "required" BOOLEAN NOT NULL DEFAULT true,
    "maxDevices" INTEGER NOT NULL DEFAULT 1,
    "profiles" TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "ModuleRoleDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleSignalDefinition" (
    "id" UUID NOT NULL,
    "processModuleTypeId" UUID NOT NULL,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "direction" "ModuleSignalDirection" NOT NULL,
    "dataType" "TagDataType" NOT NULL,
    "role" "TagRole" NOT NULL,
    "unit" TEXT,
    "signalType" TEXT,
    "required" BOOLEAN NOT NULL DEFAULT true,
    "rangeMin" DOUBLE PRECISION,
    "rangeMax" DOUBLE PRECISION,
    "moduleRoleDefinitionId" UUID,
    "profiles" TEXT[],
    "position" INTEGER NOT NULL DEFAULT 0,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ModuleSignalDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessModuleInstance" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "processModuleTypeId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "location" TEXT,
    "status" "RuntimeState" NOT NULL DEFAULT 'STOPPED',
    "profile" TEXT,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProcessModuleInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleDevice" (
    "id" UUID NOT NULL,
    "processModuleInstanceId" UUID NOT NULL,
    "moduleRoleDefinitionId" UUID NOT NULL,
    "deviceInstanceId" UUID NOT NULL,
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ModuleDevice_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleInterlock" (
    "id" UUID NOT NULL,
    "processModuleInstanceId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "expressionJson" JSONB NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'WARNING',
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "ModuleInterlock_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ProcessModuleType_code_version_key" ON "ProcessModuleType"("code", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleRoleDefinition_processModuleTypeId_key_key" ON "ModuleRoleDefinition"("processModuleTypeId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleSignalDefinition_processModuleTypeId_key_key" ON "ModuleSignalDefinition"("processModuleTypeId", "key");

-- CreateIndex
CREATE INDEX "ProcessModuleInstance_processModuleTypeId_idx" ON "ProcessModuleInstance"("processModuleTypeId");

-- CreateIndex
CREATE UNIQUE INDEX "ProcessModuleInstance_factoryId_name_key" ON "ProcessModuleInstance"("factoryId", "name");

-- CreateIndex
CREATE INDEX "ModuleDevice_deviceInstanceId_idx" ON "ModuleDevice"("deviceInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleDevice_processModuleInstanceId_moduleRoleDefinitionId_key" ON "ModuleDevice"("processModuleInstanceId", "moduleRoleDefinitionId", "deviceInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleInterlock_processModuleInstanceId_code_key" ON "ModuleInterlock"("processModuleInstanceId", "code");

-- AddForeignKey
ALTER TABLE "ModuleRoleDefinition" ADD CONSTRAINT "ModuleRoleDefinition_processModuleTypeId_fkey" FOREIGN KEY ("processModuleTypeId") REFERENCES "ProcessModuleType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleSignalDefinition" ADD CONSTRAINT "ModuleSignalDefinition_processModuleTypeId_fkey" FOREIGN KEY ("processModuleTypeId") REFERENCES "ProcessModuleType"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleSignalDefinition" ADD CONSTRAINT "ModuleSignalDefinition_moduleRoleDefinitionId_fkey" FOREIGN KEY ("moduleRoleDefinitionId") REFERENCES "ModuleRoleDefinition"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessModuleInstance" ADD CONSTRAINT "ProcessModuleInstance_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessModuleInstance" ADD CONSTRAINT "ProcessModuleInstance_processModuleTypeId_fkey" FOREIGN KEY ("processModuleTypeId") REFERENCES "ProcessModuleType"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleDevice" ADD CONSTRAINT "ModuleDevice_processModuleInstanceId_fkey" FOREIGN KEY ("processModuleInstanceId") REFERENCES "ProcessModuleInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleDevice" ADD CONSTRAINT "ModuleDevice_moduleRoleDefinitionId_fkey" FOREIGN KEY ("moduleRoleDefinitionId") REFERENCES "ModuleRoleDefinition"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleDevice" ADD CONSTRAINT "ModuleDevice_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleInterlock" ADD CONSTRAINT "ModuleInterlock_processModuleInstanceId_fkey" FOREIGN KEY ("processModuleInstanceId") REFERENCES "ProcessModuleInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CHECK constraints are not part of the Prisma schema; keep this block in sync with
-- docs/database.md → Database-enforced invariants.
ALTER TABLE "ProcessModuleType" ADD CONSTRAINT "ProcessModuleType_code_check" CHECK ("code" ~ '^[A-Z][A-Z0-9_]*$');
ALTER TABLE "ProcessModuleType" ADD CONSTRAINT "ProcessModuleType_version_check" CHECK ("version" > 0);
ALTER TABLE "ModuleRoleDefinition" ADD CONSTRAINT "ModuleRoleDefinition_max_devices_check" CHECK ("maxDevices" > 0);
ALTER TABLE "ModuleSignalDefinition" ADD CONSTRAINT "ModuleSignalDefinition_range_check" CHECK (
  "rangeMin" IS NULL OR "rangeMax" IS NULL OR "rangeMin" < "rangeMax"
);
-- An OUTPUT is what the PLC writes: a command or a setpoint, and nothing else is.
ALTER TABLE "ModuleSignalDefinition" ADD CONSTRAINT "ModuleSignalDefinition_direction_role_check" CHECK (
  ("direction" = 'OUTPUT') = ("role" IN ('COMMAND', 'SETPOINT'))
);
ALTER TABLE "ProcessModuleInstance" ADD CONSTRAINT "ProcessModuleInstance_name_check" CHECK (btrim("name") <> '');
