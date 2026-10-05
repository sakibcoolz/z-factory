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
Examples: PLC, VFD, MOTOR, PUMP, FAN, BLOWER, CONVEYOR, MIXER, COMPRESSOR, VALVE, SENSOR, SWITCH, RELAY, CONTACTOR, ENCODER, REMOTE_IO, GATEWAY. The seeded list (35 categories, including drives, controllers, remote I/O, gateways and field devices) is `lib/catalog/generic-categories.ts`.

`id, code, name, simulatorType, requiresMotor, requiresDrive, preferredDriveType`

### DeviceFamily
`id, manufacturerId, name, deviceCategoryId`

### DeviceModel
`id, familyId, modelName, sku, architectureType, runtimeSupport, controlCapability, lifecycleStatus, verificationStatus, sourceUrl, sourceTitle, sourceRevision, sourceRetrievedAt, verifiedAt, metadataJson, createdAt, updatedAt`

`verificationStatus = UNVERIFIED | VERIFIED | GENERIC`. `GENERIC` marks a simulated profile that makes no vendor claim. Unique: `(familyId, modelName)`.

For PLCs, `architectureType = COMPACT | MODULAR`; it is null for every other category.
`controlCapability = DIRECT_IO | PARAMETER_CONFIGURED | PROTOCOL_CONTROLLED | PROGRAMMABLE` says how the device is controlled. It is declared per model and never inferred from the category. `metadataJson` holds further documented facts (memory, expansion limits).
`runtimeSupport = OPENPLC | DEVICE_SIM | MODBUS_SIM | EXTERNAL | NONE` (the same `RuntimeType` enum is used by `DeviceInstance.runtimeType`; `EXTERNAL` is physical hardware outside the factory network).

### ElectricalProfile
`deviceModelId, supplyType, nominalVoltage, voltageMin, voltageMax, currentRange, powerRating, notes`

### CommunicationPort
`id, deviceModelId, name, physicalType, protocols, portCount, notes`

### DeviceIoDefinition
Reusable peripheral I/O requirement/capability.
`id, deviceModelId, direction, ioType, signalType, rangeMin, rangeMax, unit, terminalLabel, simulatorSignal, notes`

`simulatorSignal` names the signal of the device's simulator behaviour model the terminal carries (`run`, `actualFrequency`, …), so tags can be generated for it.

`direction = INPUT | OUTPUT` as seen from the device, `ioType = DIGITAL | ANALOG`, `signalType` is a normalized code such as `DC_24V`, `CURRENT_4_20MA`, `VOLTAGE_0_10V`. A device output lands on a PLC input: OUTPUT+ANALOG → AI, INPUT+ANALOG → AO, OUTPUT+DIGITAL → DI, INPUT+DIGITAL → DO.

### BuiltInIoChannel
Compact PLC channel definition.
`id, deviceModelId, ioType, channelIndex, terminalLabel, signalType, acceptedSignalTypes, addressHint, electricalLimitsJson`

`signalType` is the channel's default; `acceptedSignalTypes` lists further signal types it can be configured for. `terminalLabel` and `addressHint` are set only where the source documents them.

`ioType = DI | DO | AI | AO`. Unique: `(deviceModelId, ioType, channelIndex)`.

### RackProfile / ModuleModel / ModuleCompatibility / ModuleChannel
Used for modular PLC rack/slot/module/channel modeling.

- `RackProfile`: `id, familyId, name, slotCount, notes` — a rack/backplane a modular family can be built on. `slotCount` is the number of slots for modules next to the CPU; the CPU takes none of them.
- `ModuleModel`: `id, familyId, modelName, sku, moduleType, powerConsumption, verificationStatus, sourceUrl, sourceTitle, sourceRevision, sourceRetrievedAt, verifiedAt, metadataJson`. `moduleType = POWER_SUPPLY | DIGITAL_INPUT | DIGITAL_OUTPUT | DIGITAL_MIXED | ANALOG_INPUT | ANALOG_OUTPUT | ANALOG_MIXED | COMMUNICATION | OTHER`.
- `ModuleCompatibility`: `id, moduleModelId, cpuModelId, minSlot, maxSlot, notes` — the module may be installed with that modular CPU model, optionally only in a slot range. Unique: `(moduleModelId, cpuModelId)`.
- `ModuleChannel`: `id, moduleModelId, ioType, channelIndex, terminalLabel, signalType, acceptedSignalTypes, electricalLimitsJson`. Unique: `(moduleModelId, ioType, channelIndex)`.

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
`id, factoryId, deviceModelId, name, role, location, runtimeType, runtimeStatus, simulatorType, dockerContainerId, hostName, configJson, canvasX, canvasY, createdAt, updatedAt`

`canvasX` / `canvasY` are the device's position on the designer canvas; both are null until it is placed there.

MVP uniqueness: `unique(factoryId, name)`.

### PlcInstanceProfile
PLC-specific instance configuration.
`deviceInstanceId, programVersionId, ioMappingVersion, modbusMappingVersion, runtimeImage, runtimeVersion, imageDigest, apiHostPort`

`apiHostPort` (unique, nullable) is the loopback host port of the runtime's management API while a container exists.

### FactoryRack / FactoryModule
Selected rack and module placement for modular PLCs.

- `FactoryRack`: `id, plcInstanceId, rackProfileId, rackIndex`. Unique: `(plcInstanceId, rackIndex)`.
- `FactoryModule`: `id, factoryRackId, moduleModelId, slotIndex`. Unique: `(factoryRackId, slotIndex)` — one module per slot. Slots are numbered from 1 to the rack's `slotCount`.

A PLC gets its rack (index 0, the first rack profile of its family) when it is created.

### PlcIoPoint
Resolved available/occupied PLC endpoint.
`id, plcInstanceId, sourceType, builtInChannelId, factoryModuleId, moduleChannelId, logicalAddress, status`

`logicalAddress` is the address a program running in Z-Factory uses, not the vendor's: outputs in `%QX` / `%QW`, inputs in `%MX` / `%MW` (ADR-0010; see `docs/openplc-runtime.md` → I/O point addresses). The vendor's own terminal and address stay on the catalog channel. A compact PLC gets one point per built-in channel when it is created; a module's points are created when it is installed and deleted with it.

`sourceType = BUILT_IN | MODULE`, `status = FREE | OCCUPIED | RESERVED | DISABLED`. Unique: `(plcInstanceId, logicalAddress)`, `(plcInstanceId, builtInChannelId)`, `(factoryModuleId, moduleChannelId)`.

### Tag
`id, plcInstanceId, name, dataType, direction, role, logicalAddress, plcIoPointId, protocol, protocolArea, protocolAddress, wordCount, byteOrder, wordOrder, accessMode, scale, offset, unit, sourceDeviceInstanceId, sourceSignal, quality`

`dataType = BOOL | INT16 | UINT16 | INT32 | UINT32 | FLOAT32`, `direction = INPUT | OUTPUT | INTERNAL`, `protocolArea = COIL | DISCRETE_INPUT | HOLDING_REGISTER | INPUT_REGISTER`, `accessMode = READ_ONLY | READ_WRITE`. `protocolAddress` is zero-based within its area. `plcIoPointId` binds the tag to an I/O point (one tag per point). `quality` is the last persisted quality; live quality comes from the runtime. Unique: `(plcInstanceId, name)`, `(plcInstanceId, protocol, protocolArea, protocolAddress)`, `(sourceDeviceInstanceId, sourceSignal)`.

`sourceSignal` names the signal of the source device the tag carries to or from the device simulator (`run`, `actualFrequency`, …; see `docs/device-simulation.md`). One tag per device signal. A tag with a signal is always `READ_ONLY`.

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

## PLC-to-PLC communication (planned Phase 07)

### PlcCommunicationConnection
Defines an explicit communication relationship between two PLC instances.

`id, factoryId, sourcePlcInstanceId, targetPlcInstanceId, relationship, protocol, clientPlcInstanceId, serverPlcInstanceId, serverHost, serverPort, unitId, pollIntervalMs, enabled, createdAt, updatedAt`

`relationship = COMMUNICATES_WITH | SUPERVISES`. Initial `protocol = MODBUS_TCP`.

Rules:
- source and target PLCs are different
- both PLCs belong to the same factory in Phase 07
- client/server roles are explicit
- serverHost uses deterministic Docker DNS/service naming, never a hard-coded container IP

### PlcCommunicationMapping
Maps one local/source PLC communication tag to a remote Modbus endpoint.

`id, plcCommunicationConnectionId, localTagId, operation, remoteArea, remoteAddress, remoteTagId, dataType, wordCount, byteOrder, wordOrder, scale, offset, unit, updateIntervalMs, enabled, metadataJson`

`operation = READ | WRITE`.

Rules:
- READ may target feedback/status/process-value areas
- WRITE may target only explicitly writable COMMAND/SETPOINT endpoints
- data type, word count and register span must match
- overlapping/invalid remote mappings are rejected
- disconnect/stale quality is runtime state and may be snapshotted/events recorded


### ConfigurationVersion
`id, factoryId, scopeType, scopeId, version, snapshotJson, createdAt, createdBy`

## Process modules

Process modules compose existing factory devices and allocate process-specific logical PLC I/O. They do not redefine catalog hardware.

### ProcessModuleType
Reusable process template such as MACHINE_CELL, PUMP_HOUSE, TANK, CONVEYOR_CELL, HVAC_LOOP.

`id, code, name, version, description, simulatorModelType, configSchemaJson, createdAt, updatedAt`

Unique: `(code, version)`.

### ModuleSignalDefinition
Reusable logical I/O contract for a process-module type.

`id, processModuleTypeId, key, name, direction, dataType, role, unit, signalType, required, rangeMin, rangeMax, metadataJson`

`direction = INPUT | OUTPUT | INTERNAL | ALARM` from the PLC/control-program perspective. Unique: `(processModuleTypeId, key)`.

### ProcessModuleInstance
One factory-specific module.

`id, factoryId, processModuleTypeId, name, location, status, configJson, createdAt, updatedAt`

Unique: `(factoryId, name)`.

### ModuleDevice
Assigns an existing factory `DeviceInstance` to a process-specific role.

`id, processModuleInstanceId, deviceInstanceId, roleKey, required, metadataJson`

A device must belong to the same factory as the module. Unique: `(processModuleInstanceId, roleKey, deviceInstanceId)`.

### ModulePlcIoMapping
Binds one logical module signal to the normal PLC/tag/I/O model.

`id, processModuleInstanceId, moduleSignalDefinitionId, plcInstanceId, tagId, plcIoPointId, metadataJson`

The mapping reuses existing tag/I/O compatibility, occupancy, access-mode, protocol-address and register-overlap rules; it never creates a parallel PLC address space.

### ModuleInterlock
Process-specific interlock/validation metadata.

`id, processModuleInstanceId, code, name, expressionJson, severity, description, enabled`

This is configuration/test metadata. Safety-rated behavior is explicitly out of scope.

## Simulation/state/history

### SimulationProfile
Behavior configuration for a device model/instance: constant, ramp, sine, random, scripted, or domain-specific state machine.

`id, deviceModelId, deviceInstanceId, kind, parametersJson` — exactly one of `deviceModelId` / `deviceInstanceId` is set. `kind = CONSTANT | RAMP | SINE | RANDOM | SCRIPTED | STATE_MACHINE`.

How the device simulator reads it (TASK-204): the newest profile of the instance wins over the newest of its model. `STATE_MACHINE` carries the parameter object of the device's behaviour model. `CONSTANT`, `RAMP`, `SINE` and `RANDOM` describe the signal source of a sensor (a switch accepts `CONSTANT`). `SCRIPTED` is not supported yet. Parameters are validated when a simulation starts.

Advanced coupled process-model configuration belongs to `ProcessModuleType/ProcessModuleInstance` rather than overloading a single device profile. Phase 06 implementation will introduce the schema through TASK-601; this section documents the approved target model, not current migration state.

### DeviceRuntimeSnapshot
Latest persisted important state; not the live authority. The device simulator overwrites one row per device at its snapshot interval and when it stops; `valuesJson` holds the device's state, faults, inputs and outputs.
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
- Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/` (`init`, `device_io_endpoint`, `factory_subnet_no_overlap`, `plc_api_host_port`, `tag_source_signal`, `catalog_capabilities`, `device_io_simulator_signal`, `device_canvas_position`); generated client: `lib/generated/prisma/` (git-ignored).
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

Rules that span tables are enforced in the service layer (`lib/services/`, `lib/validation/`): compact vs modular I/O sources, module/CPU/slot compatibility, signal/point-type compatibility, I/O point ownership and availability, drive → motor categories, multi-word register overlap, process-module same-factory device assignment, required module roles/signals, module-to-PLC mapping compatibility, PLC-to-PLC same-factory validation, client/server role validation, writable-target validation, and inter-PLC register-span compatibility. `lib/db/errors.ts` turns constraint failures into typed domain errors without leaking driver messages.

The process-module tables above are **planned Phase 06 schema**, not yet present in the current Prisma migration. TASK-601 owns their implementation and database constraints.

The PLC communication tables above are **planned Phase 07 schema**, not yet present in the current Prisma migration. TASK-701/TASK-702 own their implementation and constraints.
