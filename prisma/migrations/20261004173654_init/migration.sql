-- CreateEnum
CREATE TYPE "PlcArchitecture" AS ENUM ('COMPACT', 'MODULAR');

-- CreateEnum
CREATE TYPE "RuntimeType" AS ENUM ('OPENPLC', 'DEVICE_SIM', 'MODBUS_SIM', 'EXTERNAL', 'NONE');

-- CreateEnum
CREATE TYPE "SimulatorType" AS ENUM ('NONE', 'GENERIC', 'SENSOR', 'SWITCH', 'VALVE', 'VFD', 'MOTOR', 'PUMP', 'FAN', 'CONVEYOR', 'MIXER', 'COMPRESSOR', 'RELAY');

-- CreateEnum
CREATE TYPE "DriveType" AS ENUM ('VFD', 'SERVO', 'SOFT_STARTER', 'DIRECT_ON_LINE');

-- CreateEnum
CREATE TYPE "LifecycleStatus" AS ENUM ('ACTIVE', 'PHASED_OUT', 'DISCONTINUED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "VerificationStatus" AS ENUM ('UNVERIFIED', 'VERIFIED', 'GENERIC');

-- CreateEnum
CREATE TYPE "SupplyType" AS ENUM ('AC', 'DC', 'AC_DC');

-- CreateEnum
CREATE TYPE "IoDirection" AS ENUM ('INPUT', 'OUTPUT');

-- CreateEnum
CREATE TYPE "IoSignalClass" AS ENUM ('DIGITAL', 'ANALOG');

-- CreateEnum
CREATE TYPE "IoPointType" AS ENUM ('DI', 'DO', 'AI', 'AO');

-- CreateEnum
CREATE TYPE "ModuleType" AS ENUM ('POWER_SUPPLY', 'DIGITAL_INPUT', 'DIGITAL_OUTPUT', 'DIGITAL_MIXED', 'ANALOG_INPUT', 'ANALOG_OUTPUT', 'ANALOG_MIXED', 'COMMUNICATION', 'OTHER');

-- CreateEnum
CREATE TYPE "IoPointSource" AS ENUM ('BUILT_IN', 'MODULE');

-- CreateEnum
CREATE TYPE "IoPointStatus" AS ENUM ('FREE', 'OCCUPIED', 'RESERVED', 'DISABLED');

-- CreateEnum
CREATE TYPE "Protocol" AS ENUM ('MODBUS_TCP');

-- CreateEnum
CREATE TYPE "ModbusArea" AS ENUM ('COIL', 'DISCRETE_INPUT', 'HOLDING_REGISTER', 'INPUT_REGISTER');

-- CreateEnum
CREATE TYPE "TagDataType" AS ENUM ('BOOL', 'INT16', 'UINT16', 'INT32', 'UINT32', 'FLOAT32');

-- CreateEnum
CREATE TYPE "TagDirection" AS ENUM ('INPUT', 'OUTPUT', 'INTERNAL');

-- CreateEnum
CREATE TYPE "TagRole" AS ENUM ('COMMAND', 'SETPOINT', 'FEEDBACK', 'STATUS', 'ALARM', 'PROCESS_VALUE');

-- CreateEnum
CREATE TYPE "AccessMode" AS ENUM ('READ_ONLY', 'READ_WRITE');

-- CreateEnum
CREATE TYPE "ByteOrder" AS ENUM ('BIG_ENDIAN', 'LITTLE_ENDIAN');

-- CreateEnum
CREATE TYPE "WordOrder" AS ENUM ('HIGH_WORD_FIRST', 'LOW_WORD_FIRST');

-- CreateEnum
CREATE TYPE "TagQuality" AS ENUM ('GOOD', 'STALE', 'BAD', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ConnectionRelationship" AS ENUM ('CONTROLS', 'DRIVES', 'MECHANICALLY_DRIVES', 'MEASURES', 'FEEDS_BACK_TO', 'COMMUNICATES_WITH');

-- CreateEnum
CREATE TYPE "EndpointType" AS ENUM ('DEVICE', 'PLC_IO_POINT', 'TAG', 'PROTOCOL_PORT');

-- CreateEnum
CREATE TYPE "FactoryStatus" AS ENUM ('DRAFT', 'ACTIVE', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "RuntimeState" AS ENUM ('STOPPED', 'STARTING', 'RUNNING', 'DEGRADED', 'FAULTED', 'STOPPING', 'DISCONNECTED');

-- CreateEnum
CREATE TYPE "ProgramLanguage" AS ENUM ('ST', 'LD');

-- CreateEnum
CREATE TYPE "ProgramVersionStatus" AS ENUM ('DRAFT', 'COMPILED', 'DEPLOYED', 'FAILED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "ConfigurationScope" AS ENUM ('FACTORY', 'PLC', 'IO_MAPPING', 'MODBUS_MAPPING');

-- CreateEnum
CREATE TYPE "SimulationProfileKind" AS ENUM ('CONSTANT', 'RAMP', 'SINE', 'RANDOM', 'SCRIPTED', 'STATE_MACHINE');

-- CreateEnum
CREATE TYPE "CommandSource" AS ENUM ('UI', 'GATEWAY', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CommandStatus" AS ENUM ('REQUESTED', 'ACCEPTED', 'APPLIED', 'REJECTED', 'FAILED');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('INFO', 'WARNING', 'CRITICAL');

-- CreateEnum
CREATE TYPE "FaultResetBehavior" AS ENUM ('AUTO', 'MANUAL');

-- CreateTable
CREATE TABLE "Manufacturer" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "websiteUrl" TEXT,

    CONSTRAINT "Manufacturer_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceCategory" (
    "id" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "simulatorType" "SimulatorType" NOT NULL DEFAULT 'NONE',
    "requiresMotor" BOOLEAN NOT NULL DEFAULT false,
    "requiresDrive" BOOLEAN NOT NULL DEFAULT false,
    "preferredDriveType" "DriveType",

    CONSTRAINT "DeviceCategory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFamily" (
    "id" UUID NOT NULL,
    "manufacturerId" UUID NOT NULL,
    "deviceCategoryId" UUID NOT NULL,
    "name" TEXT NOT NULL,

    CONSTRAINT "DeviceFamily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceModel" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "modelName" TEXT NOT NULL,
    "sku" TEXT,
    "architectureType" "PlcArchitecture",
    "runtimeSupport" "RuntimeType" NOT NULL DEFAULT 'NONE',
    "lifecycleStatus" "LifecycleStatus" NOT NULL DEFAULT 'UNKNOWN',
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceRevision" TEXT,
    "sourceRetrievedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ElectricalProfile" (
    "deviceModelId" UUID NOT NULL,
    "supplyType" "SupplyType",
    "nominalVoltage" DOUBLE PRECISION,
    "voltageMin" DOUBLE PRECISION,
    "voltageMax" DOUBLE PRECISION,
    "currentRange" TEXT,
    "powerRating" DOUBLE PRECISION,
    "notes" TEXT,

    CONSTRAINT "ElectricalProfile_pkey" PRIMARY KEY ("deviceModelId")
);

-- CreateTable
CREATE TABLE "CommunicationPort" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "physicalType" TEXT NOT NULL,
    "protocols" "Protocol"[],
    "portCount" INTEGER NOT NULL DEFAULT 1,
    "notes" TEXT,

    CONSTRAINT "CommunicationPort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceIoDefinition" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "direction" "IoDirection" NOT NULL,
    "ioType" "IoSignalClass" NOT NULL,
    "signalType" TEXT NOT NULL,
    "rangeMin" DOUBLE PRECISION,
    "rangeMax" DOUBLE PRECISION,
    "unit" TEXT,
    "terminalLabel" TEXT,
    "notes" TEXT,

    CONSTRAINT "DeviceIoDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BuiltInIoChannel" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "ioType" "IoPointType" NOT NULL,
    "channelIndex" INTEGER NOT NULL,
    "terminalLabel" TEXT,
    "signalType" TEXT NOT NULL,
    "addressHint" TEXT,
    "electricalLimitsJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "BuiltInIoChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RackProfile" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "slotCount" INTEGER NOT NULL,
    "notes" TEXT,

    CONSTRAINT "RackProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleModel" (
    "id" UUID NOT NULL,
    "familyId" UUID NOT NULL,
    "modelName" TEXT NOT NULL,
    "sku" TEXT,
    "moduleType" "ModuleType" NOT NULL,
    "powerConsumption" DOUBLE PRECISION,
    "verificationStatus" "VerificationStatus" NOT NULL DEFAULT 'UNVERIFIED',
    "sourceUrl" TEXT,
    "sourceTitle" TEXT,
    "sourceRevision" TEXT,
    "sourceRetrievedAt" TIMESTAMP(3),
    "verifiedAt" TIMESTAMP(3),
    "metadataJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ModuleModel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleCompatibility" (
    "id" UUID NOT NULL,
    "moduleModelId" UUID NOT NULL,
    "cpuModelId" UUID NOT NULL,
    "minSlot" INTEGER,
    "maxSlot" INTEGER,
    "notes" TEXT,

    CONSTRAINT "ModuleCompatibility_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ModuleChannel" (
    "id" UUID NOT NULL,
    "moduleModelId" UUID NOT NULL,
    "ioType" "IoPointType" NOT NULL,
    "channelIndex" INTEGER NOT NULL,
    "terminalLabel" TEXT,
    "signalType" TEXT NOT NULL,
    "electricalLimitsJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "ModuleChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceFaultDefinition" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "description" TEXT,
    "resetBehavior" "FaultResetBehavior" NOT NULL DEFAULT 'MANUAL',

    CONSTRAINT "DeviceFaultDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProtocolRegisterDefinition" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "protocol" "Protocol" NOT NULL,
    "area" "ModbusArea" NOT NULL,
    "address" INTEGER NOT NULL,
    "dataType" "TagDataType" NOT NULL,
    "wordCount" INTEGER NOT NULL DEFAULT 1,
    "byteOrder" "ByteOrder" NOT NULL DEFAULT 'BIG_ENDIAN',
    "wordOrder" "WordOrder" NOT NULL DEFAULT 'HIGH_WORD_FIRST',
    "access" "AccessMode" NOT NULL DEFAULT 'READ_ONLY',
    "scale" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "unit" TEXT,
    "semanticRole" "TagRole",

    CONSTRAINT "ProtocolRegisterDefinition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Factory" (
    "id" UUID NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "description" TEXT,
    "status" "FactoryStatus" NOT NULL DEFAULT 'DRAFT',
    "runtimeStatus" "RuntimeState" NOT NULL DEFAULT 'STOPPED',
    "dockerNetworkName" TEXT NOT NULL,
    "subnetCidr" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Factory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceInstance" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "deviceModelId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT,
    "location" TEXT,
    "runtimeType" "RuntimeType" NOT NULL DEFAULT 'NONE',
    "runtimeStatus" "RuntimeState" NOT NULL DEFAULT 'STOPPED',
    "simulatorType" "SimulatorType" NOT NULL DEFAULT 'NONE',
    "dockerContainerId" TEXT,
    "hostName" TEXT,
    "configJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceInstance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlcInstanceProfile" (
    "deviceInstanceId" UUID NOT NULL,
    "programVersionId" UUID,
    "ioMappingVersion" INTEGER NOT NULL DEFAULT 0,
    "modbusMappingVersion" INTEGER NOT NULL DEFAULT 0,
    "runtimeImage" TEXT,
    "runtimeVersion" TEXT,
    "imageDigest" TEXT,

    CONSTRAINT "PlcInstanceProfile_pkey" PRIMARY KEY ("deviceInstanceId")
);

-- CreateTable
CREATE TABLE "FactoryRack" (
    "id" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "rackProfileId" UUID NOT NULL,
    "rackIndex" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "FactoryRack_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FactoryModule" (
    "id" UUID NOT NULL,
    "factoryRackId" UUID NOT NULL,
    "moduleModelId" UUID NOT NULL,
    "slotIndex" INTEGER NOT NULL,

    CONSTRAINT "FactoryModule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlcIoPoint" (
    "id" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "sourceType" "IoPointSource" NOT NULL,
    "builtInChannelId" UUID,
    "factoryModuleId" UUID,
    "moduleChannelId" UUID,
    "logicalAddress" TEXT NOT NULL,
    "status" "IoPointStatus" NOT NULL DEFAULT 'FREE',

    CONSTRAINT "PlcIoPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Tag" (
    "id" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "dataType" "TagDataType" NOT NULL,
    "direction" "TagDirection" NOT NULL,
    "role" "TagRole" NOT NULL,
    "logicalAddress" TEXT,
    "plcIoPointId" UUID,
    "protocol" "Protocol",
    "protocolArea" "ModbusArea",
    "protocolAddress" INTEGER,
    "wordCount" INTEGER NOT NULL DEFAULT 1,
    "byteOrder" "ByteOrder" NOT NULL DEFAULT 'BIG_ENDIAN',
    "wordOrder" "WordOrder" NOT NULL DEFAULT 'HIGH_WORD_FIRST',
    "accessMode" "AccessMode" NOT NULL DEFAULT 'READ_ONLY',
    "scale" DOUBLE PRECISION NOT NULL DEFAULT 1,
    "offset" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "unit" TEXT,
    "sourceDeviceInstanceId" UUID,
    "quality" "TagQuality",

    CONSTRAINT "Tag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceConnection" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "sourceDeviceId" UUID NOT NULL,
    "targetDeviceId" UUID NOT NULL,
    "sourceEndpointType" "EndpointType" NOT NULL,
    "sourceEndpointRef" TEXT NOT NULL,
    "targetEndpointType" "EndpointType" NOT NULL,
    "targetEndpointRef" TEXT NOT NULL,
    "relationship" "ConnectionRelationship" NOT NULL,
    "protocol" "Protocol",
    "metadataJson" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DeviceConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimePort" (
    "id" UUID NOT NULL,
    "deviceInstanceId" UUID NOT NULL,
    "protocol" "Protocol" NOT NULL,
    "containerPort" INTEGER NOT NULL,
    "hostPort" INTEGER,
    "bindAddress" TEXT NOT NULL DEFAULT '127.0.0.1',

    CONSTRAINT "RuntimePort_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Gateway" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "deviceInstanceId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "RuntimeState" NOT NULL DEFAULT 'DISCONNECTED',
    "configJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Gateway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayPlcConnection" (
    "id" UUID NOT NULL,
    "gatewayId" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "protocol" "Protocol" NOT NULL DEFAULT 'MODBUS_TCP',
    "host" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "unitId" INTEGER NOT NULL DEFAULT 1,
    "pollIntervalMs" INTEGER NOT NULL DEFAULT 500,
    "enabled" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "GatewayPlcConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GatewayTagMapping" (
    "id" UUID NOT NULL,
    "gatewayPlcConnectionId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "externalName" TEXT NOT NULL,
    "accessMode" "AccessMode" NOT NULL DEFAULT 'READ_ONLY',
    "scalingJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "GatewayTagMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProgramVersion" (
    "id" UUID NOT NULL,
    "plcInstanceId" UUID NOT NULL,
    "version" INTEGER NOT NULL,
    "language" "ProgramLanguage" NOT NULL DEFAULT 'ST',
    "sourceText" TEXT NOT NULL,
    "compiledArtifactRef" TEXT,
    "checksum" TEXT NOT NULL,
    "status" "ProgramVersionStatus" NOT NULL DEFAULT 'DRAFT',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProgramVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConfigurationVersion" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "scopeType" "ConfigurationScope" NOT NULL,
    "scopeId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "snapshotJson" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdBy" TEXT NOT NULL,

    CONSTRAINT "ConfigurationVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SimulationProfile" (
    "id" UUID NOT NULL,
    "deviceModelId" UUID,
    "deviceInstanceId" UUID,
    "kind" "SimulationProfileKind" NOT NULL,
    "parametersJson" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "SimulationProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceRuntimeSnapshot" (
    "deviceInstanceId" UUID NOT NULL,
    "status" "RuntimeState" NOT NULL,
    "valuesJson" JSONB NOT NULL DEFAULT '{}',
    "quality" "TagQuality" NOT NULL DEFAULT 'GOOD',
    "capturedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceRuntimeSnapshot_pkey" PRIMARY KEY ("deviceInstanceId")
);

-- CreateTable
CREATE TABLE "DeviceCommand" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "targetDeviceId" UUID,
    "plcInstanceId" UUID NOT NULL,
    "tagId" UUID NOT NULL,
    "commandType" TEXT NOT NULL,
    "requestedValueJson" JSONB NOT NULL,
    "source" "CommandSource" NOT NULL,
    "requestedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "appliedAt" TIMESTAMP(3),
    "status" "CommandStatus" NOT NULL DEFAULT 'REQUESTED',

    CONSTRAINT "DeviceCommand_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuntimeEvent" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "deviceId" UUID,
    "type" TEXT NOT NULL,
    "severity" "Severity" NOT NULL DEFAULT 'INFO',
    "version" INTEGER NOT NULL DEFAULT 1,
    "payloadJson" JSONB NOT NULL DEFAULT '{}',
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuntimeEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlarmEvent" (
    "id" UUID NOT NULL,
    "factoryId" UUID NOT NULL,
    "deviceId" UUID,
    "code" TEXT NOT NULL,
    "severity" "Severity" NOT NULL,
    "message" TEXT NOT NULL,
    "sourceTagId" UUID,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "clearedAt" TIMESTAMP(3),
    "acknowledgedAt" TIMESTAMP(3),

    CONSTRAINT "AlarmEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetrySample" (
    "id" BIGSERIAL NOT NULL,
    "factoryId" UUID NOT NULL,
    "deviceId" UUID,
    "tagId" UUID,
    "valueNumber" DOUBLE PRECISION,
    "valueJson" JSONB,
    "quality" "TagQuality" NOT NULL DEFAULT 'GOOD',
    "sampledAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelemetrySample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Manufacturer_name_key" ON "Manufacturer"("name");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceCategory_code_key" ON "DeviceCategory"("code");

-- CreateIndex
CREATE INDEX "DeviceFamily_deviceCategoryId_idx" ON "DeviceFamily"("deviceCategoryId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFamily_manufacturerId_name_key" ON "DeviceFamily"("manufacturerId", "name");

-- CreateIndex
CREATE INDEX "DeviceModel_sku_idx" ON "DeviceModel"("sku");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceModel_familyId_modelName_key" ON "DeviceModel"("familyId", "modelName");

-- CreateIndex
CREATE UNIQUE INDEX "CommunicationPort_deviceModelId_name_key" ON "CommunicationPort"("deviceModelId", "name");

-- CreateIndex
CREATE INDEX "DeviceIoDefinition_deviceModelId_idx" ON "DeviceIoDefinition"("deviceModelId");

-- CreateIndex
CREATE UNIQUE INDEX "BuiltInIoChannel_deviceModelId_ioType_channelIndex_key" ON "BuiltInIoChannel"("deviceModelId", "ioType", "channelIndex");

-- CreateIndex
CREATE UNIQUE INDEX "RackProfile_familyId_name_key" ON "RackProfile"("familyId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleModel_familyId_modelName_key" ON "ModuleModel"("familyId", "modelName");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleCompatibility_moduleModelId_cpuModelId_key" ON "ModuleCompatibility"("moduleModelId", "cpuModelId");

-- CreateIndex
CREATE UNIQUE INDEX "ModuleChannel_moduleModelId_ioType_channelIndex_key" ON "ModuleChannel"("moduleModelId", "ioType", "channelIndex");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceFaultDefinition_deviceModelId_code_key" ON "DeviceFaultDefinition"("deviceModelId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ProtocolRegisterDefinition_deviceModelId_protocol_area_addr_key" ON "ProtocolRegisterDefinition"("deviceModelId", "protocol", "area", "address");

-- CreateIndex
CREATE UNIQUE INDEX "Factory_slug_key" ON "Factory"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "Factory_dockerNetworkName_key" ON "Factory"("dockerNetworkName");

-- CreateIndex
CREATE UNIQUE INDEX "Factory_subnetCidr_key" ON "Factory"("subnetCidr");

-- CreateIndex
CREATE UNIQUE INDEX "Factory_ownerId_name_key" ON "Factory"("ownerId", "name");

-- CreateIndex
CREATE INDEX "DeviceInstance_deviceModelId_idx" ON "DeviceInstance"("deviceModelId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceInstance_factoryId_name_key" ON "DeviceInstance"("factoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "PlcInstanceProfile_programVersionId_key" ON "PlcInstanceProfile"("programVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryRack_plcInstanceId_rackIndex_key" ON "FactoryRack"("plcInstanceId", "rackIndex");

-- CreateIndex
CREATE UNIQUE INDEX "FactoryModule_factoryRackId_slotIndex_key" ON "FactoryModule"("factoryRackId", "slotIndex");

-- CreateIndex
CREATE UNIQUE INDEX "PlcIoPoint_plcInstanceId_logicalAddress_key" ON "PlcIoPoint"("plcInstanceId", "logicalAddress");

-- CreateIndex
CREATE UNIQUE INDEX "PlcIoPoint_plcInstanceId_builtInChannelId_key" ON "PlcIoPoint"("plcInstanceId", "builtInChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "PlcIoPoint_factoryModuleId_moduleChannelId_key" ON "PlcIoPoint"("factoryModuleId", "moduleChannelId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_plcIoPointId_key" ON "Tag"("plcIoPointId");

-- CreateIndex
CREATE INDEX "Tag_sourceDeviceInstanceId_idx" ON "Tag"("sourceDeviceInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_plcInstanceId_name_key" ON "Tag"("plcInstanceId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "Tag_plcInstanceId_protocol_protocolArea_protocolAddress_key" ON "Tag"("plcInstanceId", "protocol", "protocolArea", "protocolAddress");

-- CreateIndex
CREATE INDEX "DeviceConnection_factoryId_idx" ON "DeviceConnection"("factoryId");

-- CreateIndex
CREATE INDEX "DeviceConnection_targetDeviceId_idx" ON "DeviceConnection"("targetDeviceId");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceConnection_sourceDeviceId_targetDeviceId_relationship_key" ON "DeviceConnection"("sourceDeviceId", "targetDeviceId", "relationship", "sourceEndpointRef", "targetEndpointRef");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimePort_deviceInstanceId_protocol_containerPort_key" ON "RuntimePort"("deviceInstanceId", "protocol", "containerPort");

-- CreateIndex
CREATE UNIQUE INDEX "RuntimePort_bindAddress_hostPort_key" ON "RuntimePort"("bindAddress", "hostPort");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_deviceInstanceId_key" ON "Gateway"("deviceInstanceId");

-- CreateIndex
CREATE UNIQUE INDEX "Gateway_factoryId_name_key" ON "Gateway"("factoryId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayPlcConnection_gatewayId_plcInstanceId_protocol_key" ON "GatewayPlcConnection"("gatewayId", "plcInstanceId", "protocol");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayTagMapping_gatewayPlcConnectionId_tagId_key" ON "GatewayTagMapping"("gatewayPlcConnectionId", "tagId");

-- CreateIndex
CREATE UNIQUE INDEX "GatewayTagMapping_gatewayPlcConnectionId_externalName_key" ON "GatewayTagMapping"("gatewayPlcConnectionId", "externalName");

-- CreateIndex
CREATE UNIQUE INDEX "ProgramVersion_plcInstanceId_version_key" ON "ProgramVersion"("plcInstanceId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "ConfigurationVersion_factoryId_scopeType_scopeId_version_key" ON "ConfigurationVersion"("factoryId", "scopeType", "scopeId", "version");

-- CreateIndex
CREATE INDEX "SimulationProfile_deviceModelId_idx" ON "SimulationProfile"("deviceModelId");

-- CreateIndex
CREATE INDEX "SimulationProfile_deviceInstanceId_idx" ON "SimulationProfile"("deviceInstanceId");

-- CreateIndex
CREATE INDEX "DeviceCommand_factoryId_requestedAt_idx" ON "DeviceCommand"("factoryId", "requestedAt");

-- CreateIndex
CREATE INDEX "RuntimeEvent_factoryId_occurredAt_idx" ON "RuntimeEvent"("factoryId", "occurredAt");

-- CreateIndex
CREATE INDEX "RuntimeEvent_deviceId_occurredAt_idx" ON "RuntimeEvent"("deviceId", "occurredAt");

-- CreateIndex
CREATE INDEX "AlarmEvent_factoryId_startedAt_idx" ON "AlarmEvent"("factoryId", "startedAt");

-- CreateIndex
CREATE INDEX "TelemetrySample_tagId_sampledAt_idx" ON "TelemetrySample"("tagId", "sampledAt");

-- CreateIndex
CREATE INDEX "TelemetrySample_factoryId_sampledAt_idx" ON "TelemetrySample"("factoryId", "sampledAt");

-- AddForeignKey
ALTER TABLE "DeviceFamily" ADD CONSTRAINT "DeviceFamily_manufacturerId_fkey" FOREIGN KEY ("manufacturerId") REFERENCES "Manufacturer"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceFamily" ADD CONSTRAINT "DeviceFamily_deviceCategoryId_fkey" FOREIGN KEY ("deviceCategoryId") REFERENCES "DeviceCategory"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceModel" ADD CONSTRAINT "DeviceModel_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "DeviceFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ElectricalProfile" ADD CONSTRAINT "ElectricalProfile_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommunicationPort" ADD CONSTRAINT "CommunicationPort_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceIoDefinition" ADD CONSTRAINT "DeviceIoDefinition_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BuiltInIoChannel" ADD CONSTRAINT "BuiltInIoChannel_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RackProfile" ADD CONSTRAINT "RackProfile_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "DeviceFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleModel" ADD CONSTRAINT "ModuleModel_familyId_fkey" FOREIGN KEY ("familyId") REFERENCES "DeviceFamily"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleCompatibility" ADD CONSTRAINT "ModuleCompatibility_moduleModelId_fkey" FOREIGN KEY ("moduleModelId") REFERENCES "ModuleModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleCompatibility" ADD CONSTRAINT "ModuleCompatibility_cpuModelId_fkey" FOREIGN KEY ("cpuModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ModuleChannel" ADD CONSTRAINT "ModuleChannel_moduleModelId_fkey" FOREIGN KEY ("moduleModelId") REFERENCES "ModuleModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceFaultDefinition" ADD CONSTRAINT "DeviceFaultDefinition_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProtocolRegisterDefinition" ADD CONSTRAINT "ProtocolRegisterDefinition_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInstance" ADD CONSTRAINT "DeviceInstance_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceInstance" ADD CONSTRAINT "DeviceInstance_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcInstanceProfile" ADD CONSTRAINT "PlcInstanceProfile_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcInstanceProfile" ADD CONSTRAINT "PlcInstanceProfile_programVersionId_fkey" FOREIGN KEY ("programVersionId") REFERENCES "ProgramVersion"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryRack" ADD CONSTRAINT "FactoryRack_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryRack" ADD CONSTRAINT "FactoryRack_rackProfileId_fkey" FOREIGN KEY ("rackProfileId") REFERENCES "RackProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryModule" ADD CONSTRAINT "FactoryModule_factoryRackId_fkey" FOREIGN KEY ("factoryRackId") REFERENCES "FactoryRack"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FactoryModule" ADD CONSTRAINT "FactoryModule_moduleModelId_fkey" FOREIGN KEY ("moduleModelId") REFERENCES "ModuleModel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcIoPoint" ADD CONSTRAINT "PlcIoPoint_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcIoPoint" ADD CONSTRAINT "PlcIoPoint_builtInChannelId_fkey" FOREIGN KEY ("builtInChannelId") REFERENCES "BuiltInIoChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcIoPoint" ADD CONSTRAINT "PlcIoPoint_factoryModuleId_fkey" FOREIGN KEY ("factoryModuleId") REFERENCES "FactoryModule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlcIoPoint" ADD CONSTRAINT "PlcIoPoint_moduleChannelId_fkey" FOREIGN KEY ("moduleChannelId") REFERENCES "ModuleChannel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_plcIoPointId_fkey" FOREIGN KEY ("plcIoPointId") REFERENCES "PlcIoPoint"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_sourceDeviceInstanceId_fkey" FOREIGN KEY ("sourceDeviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_sourceDeviceId_fkey" FOREIGN KEY ("sourceDeviceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimePort" ADD CONSTRAINT "RuntimePort_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Gateway" ADD CONSTRAINT "Gateway_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayPlcConnection" ADD CONSTRAINT "GatewayPlcConnection_gatewayId_fkey" FOREIGN KEY ("gatewayId") REFERENCES "Gateway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayPlcConnection" ADD CONSTRAINT "GatewayPlcConnection_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayTagMapping" ADD CONSTRAINT "GatewayTagMapping_gatewayPlcConnectionId_fkey" FOREIGN KEY ("gatewayPlcConnectionId") REFERENCES "GatewayPlcConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GatewayTagMapping" ADD CONSTRAINT "GatewayTagMapping_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProgramVersion" ADD CONSTRAINT "ProgramVersion_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConfigurationVersion" ADD CONSTRAINT "ConfigurationVersion_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationProfile" ADD CONSTRAINT "SimulationProfile_deviceModelId_fkey" FOREIGN KEY ("deviceModelId") REFERENCES "DeviceModel"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SimulationProfile" ADD CONSTRAINT "SimulationProfile_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceRuntimeSnapshot" ADD CONSTRAINT "DeviceRuntimeSnapshot_deviceInstanceId_fkey" FOREIGN KEY ("deviceInstanceId") REFERENCES "DeviceInstance"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_targetDeviceId_fkey" FOREIGN KEY ("targetDeviceId") REFERENCES "DeviceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_plcInstanceId_fkey" FOREIGN KEY ("plcInstanceId") REFERENCES "PlcInstanceProfile"("deviceInstanceId") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceCommand" ADD CONSTRAINT "DeviceCommand_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEvent" ADD CONSTRAINT "RuntimeEvent_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuntimeEvent" ADD CONSTRAINT "RuntimeEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmEvent" ADD CONSTRAINT "AlarmEvent_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmEvent" ADD CONSTRAINT "AlarmEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AlarmEvent" ADD CONSTRAINT "AlarmEvent_sourceTagId_fkey" FOREIGN KEY ("sourceTagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_factoryId_fkey" FOREIGN KEY ("factoryId") REFERENCES "Factory"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "DeviceInstance"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "Tag"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ─────────────────────────────────────────────────────────────────────────────
-- Invariants Prisma cannot express (docs/database.md -> Database-enforced invariants).
-- CHECK and EXCLUDE constraints are not part of the Prisma schema; keep this block in
-- sync with the docs when adding to it in later migrations.
-- ─────────────────────────────────────────────────────────────────────────────

-- Compact vs modular: an I/O point comes from a built-in channel or from a module channel, never both.
ALTER TABLE "PlcIoPoint" ADD CONSTRAINT "PlcIoPoint_source_check" CHECK (
  ("sourceType" = 'BUILT_IN' AND "builtInChannelId" IS NOT NULL AND "factoryModuleId" IS NULL AND "moduleChannelId" IS NULL)
  OR
  ("sourceType" = 'MODULE' AND "builtInChannelId" IS NULL AND "factoryModuleId" IS NOT NULL AND "moduleChannelId" IS NOT NULL)
);

-- Command/setpoint vs feedback: only COMMAND and SETPOINT tags may be writable.
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_writable_role_check" CHECK (
  "accessMode" = 'READ_ONLY' OR "role" IN ('COMMAND', 'SETPOINT')
);

-- A protocol mapping is complete or absent; addresses are zero-based.
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_protocol_mapping_check" CHECK (
  ("protocol" IS NULL AND "protocolArea" IS NULL AND "protocolAddress" IS NULL)
  OR
  ("protocol" IS NOT NULL AND "protocolArea" IS NOT NULL AND "protocolAddress" IS NOT NULL AND "protocolAddress" >= 0)
);

-- Discrete inputs and input registers are read-only Modbus areas.
ALTER TABLE "Tag" ADD CONSTRAINT "Tag_writable_area_check" CHECK (
  "accessMode" = 'READ_ONLY' OR "protocolArea" IS NULL OR "protocolArea" IN ('COIL', 'HOLDING_REGISTER')
);

ALTER TABLE "Tag" ADD CONSTRAINT "Tag_word_count_check" CHECK ("wordCount" >= 1);

-- A device is never connected to itself.
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_distinct_devices_check" CHECK (
  "sourceDeviceId" <> "targetDeviceId"
);

-- MVP: one drive (VFD) drives one primary motor, and a motor has one drive.
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_one_motor_per_drive"
  EXCLUDE USING btree ("sourceDeviceId" WITH =) WHERE ("relationship" = 'DRIVES');
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_one_drive_per_motor"
  EXCLUDE USING btree ("targetDeviceId" WITH =) WHERE ("relationship" = 'DRIVES');

-- A PLC I/O point is wired at most once on each side of a connection.
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_source_io_point_once"
  EXCLUDE USING btree ("sourceEndpointRef" WITH =) WHERE ("sourceEndpointType" = 'PLC_IO_POINT');
ALTER TABLE "DeviceConnection" ADD CONSTRAINT "DeviceConnection_target_io_point_once"
  EXCLUDE USING btree ("targetEndpointRef" WITH =) WHERE ("targetEndpointType" = 'PLC_IO_POINT');

-- A simulation profile belongs to exactly one of: a device model or a device instance.
ALTER TABLE "SimulationProfile" ADD CONSTRAINT "SimulationProfile_single_owner_check" CHECK (
  num_nonnulls("deviceModelId", "deviceInstanceId") = 1
);

-- Rack, slot and port ranges.
ALTER TABLE "RackProfile" ADD CONSTRAINT "RackProfile_slot_count_check" CHECK ("slotCount" >= 1);
ALTER TABLE "FactoryModule" ADD CONSTRAINT "FactoryModule_slot_index_check" CHECK ("slotIndex" >= 0);
ALTER TABLE "ModuleCompatibility" ADD CONSTRAINT "ModuleCompatibility_slot_range_check" CHECK (
  "minSlot" IS NULL OR "maxSlot" IS NULL OR "minSlot" <= "maxSlot"
);
ALTER TABLE "RuntimePort" ADD CONSTRAINT "RuntimePort_port_range_check" CHECK (
  "containerPort" BETWEEN 1 AND 65535 AND ("hostPort" IS NULL OR "hostPort" BETWEEN 1 AND 65535)
);
ALTER TABLE "GatewayPlcConnection" ADD CONSTRAINT "GatewayPlcConnection_range_check" CHECK (
  "port" BETWEEN 1 AND 65535 AND "unitId" BETWEEN 0 AND 255 AND "pollIntervalMs" >= 1
);

-- Identity fields are never blank; slugs are URL-safe.
ALTER TABLE "Factory" ADD CONSTRAINT "Factory_name_check" CHECK (btrim("name") <> '');
ALTER TABLE "Factory" ADD CONSTRAINT "Factory_slug_check" CHECK ("slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$');
ALTER TABLE "DeviceInstance" ADD CONSTRAINT "DeviceInstance_name_check" CHECK (btrim("name") <> '');

-- History sanity.
ALTER TABLE "AlarmEvent" ADD CONSTRAINT "AlarmEvent_cleared_after_started_check" CHECK (
  "clearedAt" IS NULL OR "clearedAt" >= "startedAt"
);
ALTER TABLE "TelemetrySample" ADD CONSTRAINT "TelemetrySample_value_check" CHECK (
  "valueNumber" IS NOT NULL OR "valueJson" IS NOT NULL
);
