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
`id, familyId, modelName, sku, architectureType, runtimeSupport, lifecycleStatus, verificationStatus, sourceUrl, sourceTitle, sourceRevision, sourceRetrievedAt, verifiedAt, metadataJson, createdAt, updatedAt`

`verificationStatus = UNVERIFIED | VERIFIED | GENERIC`. `GENERIC` marks a simulated profile that makes no vendor claim. Unique: `(familyId, modelName)`.

For PLCs, `architectureType = COMPACT | MODULAR`; it is null for every other category.
`runtimeSupport = OPENPLC | DEVICE_SIM | MODBUS_SIM | EXTERNAL | NONE` (the same `RuntimeType` enum is used by `DeviceInstance.runtimeType`; `EXTERNAL` is physical hardware outside the factory network).

### ElectricalProfile
`deviceModelId, supplyType, nominalVoltage, voltageMin, voltageMax, currentRange, powerRating, notes`

### CommunicationPort
`id, deviceModelId, name, physicalType, protocols, portCount, notes`

### DeviceIoDefinition
Reusable peripheral I/O requirement/capability.
`id, deviceModelId, direction, ioType, signalType, rangeMin, rangeMax, unit, terminalLabel, notes`

`direction = INPUT | OUTPUT` as seen from the device, `ioType = DIGITAL | ANALOG`, `signalType` is a normalized code such as `DC_24V`, `CURRENT_4_20MA`, `VOLTAGE_0_10V`. A device output lands on a PLC input: OUTPUT+ANALOG → AI, INPUT+ANALOG → AO, OUTPUT+DIGITAL → DI, INPUT+DIGITAL → DO.

### BuiltInIoChannel
Compact PLC channel definition.
`id, deviceModelId, ioType, channelIndex, terminalLabel, signalType, addressHint, electricalLimitsJson`

`ioType = DI | DO | AI | AO`. Unique: `(deviceModelId, ioType, channelIndex)`.

### RackProfile / ModuleModel / ModuleCompatibility / ModuleChannel
Used for modular PLC rack/slot/module/channel modeling.

- `RackProfile`: `id, familyId, name, slotCount, notes` — a rack/backplane a modular family can be built on.
- `ModuleModel`: `id, familyId, modelName, sku, moduleType, powerConsumption, verificationStatus, sourceUrl, sourceTitle, sourceRevision, sourceRetrievedAt, verifiedAt, metadataJson`. `moduleType = POWER_SUPPLY | DIGITAL_INPUT | DIGITAL_OUTPUT | DIGITAL_MIXED | ANALOG_INPUT | ANALOG_OUTPUT | ANALOG_MIXED | COMMUNICATION | OTHER`.
- `ModuleCompatibility`: `id, moduleModelId, cpuModelId, minSlot, maxSlot, notes` — the module may be installed with that modular CPU model, optionally only in a slot range. Unique: `(moduleModelId, cpuModelId)`.
- `ModuleChannel`: `id, moduleModelId, ioType, channelIndex, terminalLabel, signalType, electricalLimitsJson`. Unique: `(moduleModelId, ioType, channelIndex)`.

### DeviceFaultDefinition
`id, deviceModelId, code, name, severity, description, resetBehavior`

### ProtocolRegisterDefinition
Optional model-level register definition for smart devices.
`id, deviceModelId, protocol, area, address, dataType, wordCount, byteOrder, wordOrder, access, scale, unit, semanticRole`

## Factory/runtime entities

### Factory
`id, ownerId, name, slug, description, status, runtimeStatus, dockerNetworkName, subnetCidr, createdAt, updatedAt`

`status = DRAFT | ACTIVE | ARCHIVED` is the desired/configuration status; `runtimeStatus` is the last persisted runtime state. `ownerId` is an opaque owner identity until an authentication provider is chosen. Unique: `slug`, `dockerNetworkName`, `subnetCidr`, `(ownerId, name)`.

### DeviceInstance
A named device created inside one factory.
`id, factoryId, deviceModelId, name, role, location, runtimeType, runtimeStatus, simulatorType, dockerContainerId, hostName, configJson, createdAt, updatedAt`

MVP uniqueness: `unique(factoryId, name)`.

### PlcInstanceProfile
PLC-specific instance configuration.
`deviceInstanceId, programVersionId, ioMappingVersion, modbusMappingVersion, runtimeImage, runtimeVersion, imageDigest`

### FactoryRack / FactoryModule
Selected rack and module placement for modular PLCs.

- `FactoryRack`: `id, plcInstanceId, rackProfileId, rackIndex`. Unique: `(plcInstanceId, rackIndex)`.
- `FactoryModule`: `id, factoryRackId, moduleModelId, slotIndex`. Unique: `(factoryRackId, slotIndex)` — one module per slot.

### PlcIoPoint
Resolved available/occupied PLC endpoint.
`id, plcInstanceId, sourceType, builtInChannelId, factoryModuleId, moduleChannelId, logicalAddress, status`

`sourceType = BUILT_IN | MODULE`, `status = FREE | OCCUPIED | RESERVED | DISABLED`. Unique: `(plcInstanceId, logicalAddress)`, `(plcInstanceId, builtInChannelId)`, `(factoryModuleId, moduleChannelId)`.

### Tag
`id, plcInstanceId, name, dataType, direction, role, logicalAddress, plcIoPointId, protocol, protocolArea, protocolAddress, wordCount, byteOrder, wordOrder, accessMode, scale, offset, unit, sourceDeviceInstanceId, quality`

`dataType = BOOL | INT16 | UINT16 | INT32 | UINT32 | FLOAT32`, `direction = INPUT | OUTPUT | INTERNAL`, `protocolArea = COIL | DISCRETE_INPUT | HOLDING_REGISTER | INPUT_REGISTER`, `accessMode = READ_ONLY | READ_WRITE`. `protocolAddress` is zero-based within its area. `plcIoPointId` binds the tag to an I/O point (one tag per point). `quality` is the last persisted quality; live quality comes from the runtime. Unique: `(plcInstanceId, name)`, `(plcInstanceId, protocol, protocolArea, protocolAddress)`.

`role = COMMAND | SETPOINT | FEEDBACK | STATUS | ALARM | PROCESS_VALUE`.

### DeviceConnection
`id, factoryId, sourceDeviceId, targetDeviceId, sourceEndpointType, sourceEndpointRef, targetEndpointType, targetEndpointRef, relationship, protocol, metadataJson`

Relationships include `CONTROLS`, `DRIVES`, `MECHANICALLY_DRIVES`, `MEASURES`, `FEEDS_BACK_TO`, `COMMUNICATES_WITH`.

Endpoint types: `DEVICE` (the device itself), `DEVICE_IO` (a peripheral terminal — a `DeviceIoDefinition` of the device's model), `PLC_IO_POINT`, `TAG`, `PROTOCOL_PORT`. `*EndpointRef` holds the id of the referenced row (the device id for `DEVICE`).

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

`id, deviceModelId, deviceInstanceId, kind, parametersJson` — exactly one of `deviceModelId` / `deviceInstanceId` is set. `kind = CONSTANT | RAMP | SINE | RANDOM | SCRIPTED | STATE_MACHINE`.

### DeviceRuntimeSnapshot
Latest persisted important state; not the live authority.
`deviceInstanceId, status, valuesJson, quality, capturedAt`

### DeviceCommand
`id, factoryId, targetDeviceId, plcInstanceId, tagId, commandType, requestedValueJson, source, requestedAt, appliedAt, status`

### RuntimeEvent
`id, factoryId, deviceId, type, severity, version, payloadJson, occurredAt`

`version` is the payload-shape version (event payloads are versioned).

### AlarmEvent
`id, factoryId, deviceId, code, severity, message, sourceTagId, startedAt, clearedAt, acknowledgedAt`

### TelemetrySample
`id, factoryId, deviceId, tagId, valueNumber, valueJson, quality, sampledAt`

For high-volume history, partitioning/retention should be introduced first. TimescaleDB may be considered later without changing PostgreSQL as the primary relational store.

## Catalog provenance
Every factual vendor hardware profile keeps source URL plus verification metadata. Never fabricate pinouts, I/O counts, register maps, or electrical limits.

## Implementation (TASK-102)
- Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/` (`init`, `device_io_endpoint`, `factory_subnet_no_overlap`); generated client: `lib/generated/prisma/` (git-ignored).
- Primary keys are UUID v7 (`@default(uuid(7))`, PostgreSQL `uuid`), except `TelemetrySample.id` (`bigint` identity) and the one-to-one tables keyed by their owner (`ElectricalProfile`, `PlcInstanceProfile`, `DeviceRuntimeSnapshot`).
- Catalog rows referenced by factory data are protected with `ON DELETE RESTRICT`; factory-owned rows cascade from `Factory`.
- `DeviceInstance.dockerContainerId` is server-side only and never sent to the browser.
- Seed: `prisma/seed.ts` inserts only the generic `DeviceCategory` rows from `lib/catalog/generic-categories.ts`. Vendor models are never seeded; they enter through the verified ingestion of TASK-301.

## Database-enforced invariants
Prisma cannot express CHECK or EXCLUDE constraints, so these live as hand-written SQL in the migrations (most at the end of `init`). Prisma Migrate leaves them alone. Add new ones in a migration and list them here.

| Constraint | Rule |
|---|---|
| `PlcIoPoint_source_check` | `BUILT_IN` points reference a built-in channel only; `MODULE` points reference a factory module and a module channel only |
| `Tag_writable_role_check` | `READ_WRITE` only when `role` is `COMMAND` or `SETPOINT` |
| `Tag_writable_area_check` | `READ_WRITE` only in `COIL` / `HOLDING_REGISTER` areas |
| `Tag_protocol_mapping_check` | protocol, area and address are all set or all null; address is zero-based (>= 0) |
| `Tag_word_count_check` | `wordCount >= 1` |
| `DeviceConnection_distinct_devices_check` | a device is never connected to itself |
| `DeviceConnection_one_motor_per_drive` | at most one `DRIVES` connection per source device (one VFD → one primary motor) |
| `DeviceConnection_one_drive_per_motor` | at most one `DRIVES` connection per target device |
| `DeviceConnection_source_io_point_once`, `DeviceConnection_target_io_point_once` | a PLC I/O point is wired at most once on each side |
| `SimulationProfile_single_owner_check` | exactly one of model / instance |
| `RackProfile_slot_count_check`, `FactoryModule_slot_index_check`, `ModuleCompatibility_slot_range_check` | rack and slot ranges |
| `RuntimePort_port_range_check`, `GatewayPlcConnection_range_check` | port 1–65535, unit id 0–255, poll interval >= 1 ms |
| `Factory_name_check`, `Factory_slug_check`, `DeviceInstance_name_check` | non-blank names, URL-safe slug |
| `Factory_subnet_no_overlap` | no two factories have overlapping subnets (GiST exclusion on `subnetCidr::inet`), across owners — Docker networks share the host's address space |
| `AlarmEvent_cleared_after_started_check`, `TelemetrySample_value_check` | history sanity |

Rules that span tables are enforced in the service layer (`lib/services/`, `lib/validation/`): compact vs modular I/O sources, module/CPU/slot compatibility, signal/point-type compatibility, I/O point ownership and availability, drive → motor categories, and multi-word register overlap. `lib/db/errors.ts` turns constraint failures into typed domain errors without leaking driver messages.
