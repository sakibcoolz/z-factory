# Database Design

Primary database: **PostgreSQL** with **Prisma**.

PostgreSQL is the durable system of record for catalog facts, factory configuration, relationships, mappings, program/config versions, commands, alarms/events/audit history, and selected telemetry. It is **not** the authoritative memory for every live simulator tick.

## Core design rules
- Catalog definitions are reusable; factory/device instances are factory-specific.
- Device instance names are unique within a factory.
- Compact PLC built-in I/O and modular PLC rack/module I/O are modeled separately.
- A physical/logical connection references explicit endpoints.
- Commands/setpoints are distinct from feedback/status/alarm values.
- Runtime state may be snapshotted, but runtime/simulator memory is the live authority.
- High-frequency telemetry is sampled/downsampled; do not persist every PLC scan indiscriminately.

## Catalog entities

### Manufacturer
`id, name, websiteUrl`

### DeviceCategory
Examples: PLC, VFD, MOTOR, PUMP, FAN, BLOWER, CONVEYOR, MIXER, COMPRESSOR, VALVE, SENSOR, SWITCH, RELAY, CONTACTOR, ENCODER, REMOTE_IO, GATEWAY.

`id, code, name, simulatorType, requiresMotor, requiresDrive, preferredDriveType`

### DeviceFamily
`id, manufacturerId, name, deviceCategoryId`

### DeviceModel
`id, familyId, modelName, sku, architectureType, runtimeSupport, lifecycleStatus, sourceUrl, sourceRevision, verifiedAt, metadataJson`

For PLCs, `architectureType = COMPACT | MODULAR`.
Runtime support examples: `OPENPLC | DEVICE_SIM | MODBUS_SIM | NONE`.

### ElectricalProfile
`deviceModelId, supplyType, nominalVoltage, voltageMin, voltageMax, currentRange, powerRating, notes`

### CommunicationPort
`id, deviceModelId, name, physicalType, protocols, portCount, notes`

### DeviceIoDefinition
Reusable peripheral I/O requirement/capability.
`id, deviceModelId, direction, ioType, signalType, rangeMin, rangeMax, unit, terminalLabel, notes`

### BuiltInIoChannel
Compact PLC channel definition.
`id, deviceModelId, ioType, channelIndex, terminalLabel, signalType, addressHint, electricalLimitsJson`

### RackProfile / ModuleModel / ModuleCompatibility / ModuleChannel
Used for modular PLC rack/slot/module/channel modeling.

### DeviceFaultDefinition
`id, deviceModelId, code, name, severity, description, resetBehavior`

### ProtocolRegisterDefinition
Optional model-level register definition for smart devices.
`id, deviceModelId, protocol, area, address, dataType, wordCount, byteOrder, wordOrder, access, scale, unit, semanticRole`

## Factory/runtime entities

### Factory
`id, ownerId, name, slug, status, runtimeStatus, dockerNetworkName, subnetCidr, createdAt, updatedAt`

### DeviceInstance
A named device created inside one factory.
`id, factoryId, deviceModelId, name, role, location, runtimeType, runtimeStatus, simulatorType, dockerContainerId, hostName, configJson, createdAt, updatedAt`

MVP uniqueness: `unique(factoryId, name)`.

### PlcInstanceProfile
PLC-specific instance configuration.
`deviceInstanceId, programVersionId, ioMappingVersion, modbusMappingVersion, runtimeImage, runtimeVersion, imageDigest`

### FactoryRack / FactoryModule
Selected rack and module placement for modular PLCs.

### PlcIoPoint
Resolved available/occupied PLC endpoint.
`id, plcInstanceId, sourceType, builtInChannelId, factoryModuleId, moduleChannelId, logicalAddress, status`

### Tag
`id, plcInstanceId, name, dataType, direction, role, logicalAddress, protocol, protocolArea, protocolAddress, wordCount, byteOrder, wordOrder, accessMode, scale, unit, sourceDeviceInstanceId, quality`

`role = COMMAND | SETPOINT | FEEDBACK | STATUS | ALARM | PROCESS_VALUE`.

### DeviceConnection
`id, factoryId, sourceDeviceId, targetDeviceId, sourceEndpointType, sourceEndpointRef, targetEndpointType, targetEndpointRef, relationship, protocol, metadataJson`

Relationships include `CONTROLS`, `DRIVES`, `MECHANICALLY_DRIVES`, `MEASURES`, `FEEDS_BACK_TO`, `COMMUNICATES_WITH`.

MVP invariant: one VFD instance has at most one primary motor relationship.

### RuntimePort
`id, deviceInstanceId, protocol, containerPort, hostPort, bindAddress`

### Gateway
`id, factoryId, deviceInstanceId, name, status, configJson`

### GatewayPlcConnection
`id, gatewayId, plcInstanceId, protocol, host, port, unitId, pollIntervalMs, enabled`

### GatewayTagMapping
`id, gatewayPlcConnectionId, tagId, externalName, accessMode, scalingJson`

### ProgramVersion
`id, plcInstanceId, version, language, sourceText, compiledArtifactRef, checksum, status, createdAt`

### ConfigurationVersion
`id, factoryId, scopeType, scopeId, version, snapshotJson, createdAt, createdBy`

## Simulation/state/history

### SimulationProfile
Behavior configuration for a device model/instance: constant, ramp, sine, random, scripted, or domain-specific state machine.

### DeviceRuntimeSnapshot
Latest persisted important state; not the live authority.
`deviceInstanceId, status, valuesJson, quality, capturedAt`

### DeviceCommand
`id, factoryId, targetDeviceId, plcInstanceId, tagId, commandType, requestedValueJson, source, requestedAt, appliedAt, status`

### RuntimeEvent
`id, factoryId, deviceId, type, severity, payloadJson, occurredAt`

### AlarmEvent
`id, factoryId, deviceId, code, severity, message, sourceTagId, startedAt, clearedAt, acknowledgedAt`

### TelemetrySample
`id, factoryId, deviceId, tagId, valueNumber, valueJson, quality, sampledAt`

For high-volume history, partitioning/retention should be introduced first. TimescaleDB may be considered later without changing PostgreSQL as the primary relational store.

## Catalog provenance
Every factual vendor hardware profile keeps source URL plus verification metadata. Never fabricate pinouts, I/O counts, register maps, or electrical limits.
