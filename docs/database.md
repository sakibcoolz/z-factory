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
`id, familyId, modelName, sku, architectureType, runtimeSupport, controlCapability, lifecycleStatus, verificationStatus, sourceUrl, sourceTitle, sourceRevision, sourceRetrievedAt, verifiedAt, metadataJson, active3dAssetId, createdAt, updatedAt`

`capabilities` (`DeviceCapability[]`, TASK-308) states what Z-Factory can do with the model: `PROGRAMMABLE`, `IEC_61131_3`, `SCRIPTABLE`, `PARAMETER_CONFIGURABLE`, `LOCAL_CONTROL`, `REMOTE_CONTROL`, `DATA_LOGGING`, `MODBUS_CLIENT`, `MODBUS_SERVER`, `REMOTE_IO`, `FIRMWARE_DEPLOYABLE`. Screens, checks and runtime adapters follow these; nothing is inferred from a category. A programmable controller (a `PLC` or `RTU` model with `PROGRAMMABLE`) declares `architectureType`; no other model does.

`active3dAssetId` names the `Catalog3dAsset` version every instance of the model renders; null means the generic shape of the category.

`verificationStatus = UNVERIFIED | VERIFIED | GENERIC`. `GENERIC` marks a simulated profile that makes no vendor claim. Unique: `(familyId, modelName)`.

For PLCs, `architectureType = COMPACT | MODULAR`; it is null for every other category.
`controlCapability = DIRECT_IO | PARAMETER_CONFIGURED | PROTOCOL_CONTROLLED | PROGRAMMABLE` says how the device is controlled. It is declared per model and never inferred from the category. `metadataJson` holds further documented facts (memory, expansion limits).
`runtimeSupport = OPENPLC | DEVICE_SIM | MODBUS_SIM | EXTERNAL | NONE` (the same `RuntimeType` enum is used by `DeviceInstance.runtimeType`; `EXTERNAL` is physical hardware outside the factory network).

### ElectricalProfile
`deviceModelId, supplyType, nominalVoltage, voltageMin, voltageMax, currentRange, powerRating, notes`

### CommunicationPort
`id, deviceModelId, name, physicalType, protocols, portCount, maxConnections, notes`

A port is a bus endpoint: it is shared. `maxConnections` (default 16) is the number of links Z-Factory allows on it (ADR-0014).

### DeviceIoDefinition
A terminal of a device model, seen from the device.
`id, deviceModelId, kind, maxConnections, direction, ioType, signalType, rangeMin, rangeMax, unit, terminalLabel, simulatorSignal, notes`

`kind = SIGNAL | POWER | COMMON | EARTH` (TASK-307). A `SIGNAL` terminal carries one process signal and is what a PLC channel is wired to. A `POWER` terminal supplies (`OUTPUT`) or takes (`INPUT`) the voltage named by `signalType`. `COMMON` is 0 V and `EARTH` is protective earth; for these two `direction`, `ioType` and `signalType` are not meaningful (stored as `INPUT`, `DIGITAL` and an empty string). `maxConnections` is the number of wires the terminal takes: 1 unless the catalog marks it as shared.

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

### Catalog3dAsset
One version of the reusable 3D asset of a catalog model (TASK-402, ADR-0012). The file is in asset storage; this row is its record.
`id, deviceModelId, version, status, storageKey, contentSha256, sizeBytes, provider, providerJobId, providerStatus, statusMessage, generationJson, scale, rotationYDeg, boundsJson, validationJson, createdAt, updatedAt`

`status = PENDING | READY | FAILED | RETIRED`; only `READY` is rendered and served.

| Status | Meaning | Set by |
|---|---|---|
| `PENDING` | a generation job is running; the version has no file | `openCatalogAssetJob` (TASK-403) |
| `READY` | stored, normalized and checked | `registerCatalogAsset`, `completeCatalogAssetJob` |
| `FAILED` | the provider failed the job, or its file was refused; kept as the record | `failCatalogAssetJob` |
| `RETIRED` | taken out of use on purpose; never rendered or served again | `retireCatalogAsset` |

`storageKey` is the file's path inside asset storage (`models/<model id>/v<version>/model.glb`); it is null for a version without a file and after a retired version's file was deleted. `provider` says where the file came from (`MESHY`, `MANUAL`); `providerJobId` is the provider's own id of the last job (the texture job when there is one). `providerStatus` is what the provider last said about the job (`mesh in progress 40%`); `statusMessage` says why a version is pending, failed or retired. `generationJson` is how the file was asked for: prompt, texture prompt, provider model, polygon target, the shape key, and the provider's job ids so that an interrupted job can be continued; for a shared file, the asset it was copied from. It never holds a key or a download address.

`scale` is a uniform factor for the file's units; null fits the model into the space of its category. `rotationYDeg` turns the file's front to the scene's front. A file that went through the authoring path is normalized (metres, upright, standing on its origin), so its `scale` is 1 and its `rotationYDeg` 0. `boundsJson` is the box around the model: `{ min, max, anchor }` in metres for a normalized file, else the box the file states (file units, an estimate). `validationJson` is what the check found (`{ ok, generator, counts, normalization }`), or `{ ok: false, message }` for a failed job. Unique: `(deviceModelId, version)`. Deleting a model deletes its asset records; deleting an asset clears `DeviceModel.active3dAssetId`.

That the active asset belongs to the same model and is ready, and that a model has at most one pending job, is kept by the asset service, not by a constraint.

### DeviceInstance
A named device created inside one factory.
`id, factoryId, deviceModelId, name, role, location, runtimeType, runtimeStatus, simulatorType, dockerContainerId, hostName, configJson, canvasX, canvasY, sceneRotationDeg, sceneScale, createdAt, updatedAt`

`canvasX` / `canvasY` are the device's position on the designer canvas; both are null until it is placed there. The 3D view uses the same position.
`sceneRotationDeg` (0 to below 360, default 0) and `sceneScale` (default 1) are how this instance is turned and sized in the 3D view. They are appearance only.

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

Relationships: `CONTROLS`, `DRIVES`, `MECHANICALLY_DRIVES`, `MEASURES`, `FEEDS_BACK_TO`, `COMMUNICATES_WITH`, `WIRED_TO`.

A row whose endpoints are terminals, PLC I/O points or ports is **one wire between two exact endpoints**, and these rows are the only source of wiring (ADR-0014). It is stored from the end that drives or supplies to the end that reads or takes. A wire between a PLC channel and a terminal keeps `CONTROLS` (PLC output → device input) or `FEEDS_BACK_TO` (device output → PLC input) and has a tag bound to the channel; a link between two ports is `COMMUNICATES_WITH`; every other wire (supply, 0 V, earth, a signal between two devices) is `WIRED_TO`. A row with `DEVICE` endpoints is a relationship between two devices, not a wire.

A terminal id belongs to a catalog model, so an endpoint is identified by the device and the reference together.

Endpoint types: `DEVICE` (the device itself), `DEVICE_IO` (a peripheral terminal — a `DeviceIoDefinition` of the device's model), `PLC_IO_POINT`, `TAG`, `PROTOCOL_PORT`. `*EndpointRef` holds the id of the referenced row (the device id for `DEVICE`).

MVP invariant: one VFD instance has at most one primary motor relationship.

### RuntimePort
`id, deviceInstanceId, protocol, containerPort, hostPort, bindAddress`

### Gateway
`id, factoryId, deviceInstanceId, name, status, configJson`

The record of an external gateway (TASK-501): one per gateway device instance (category `GATEWAY` or `EDGE_GATEWAY`), created when the device is first connected to a PLC. `status` is `RUNNING` while its endpoints are open, `FAULTED` when one could not be opened, `STOPPED` otherwise.

### GatewayPlcConnection
`id, gatewayId, plcInstanceId, protocol, host, port, unitId, pollIntervalMs, enabled`

Where the external device connects to reach that PLC's tags (ADR-0013): `host` and `port` are an address and port of the Z-Factory host on which the gateway endpoint listens, not the PLC's own Modbus port. `unitId` is the only unit id the endpoint answers for; `pollIntervalMs` is how often the device is expected to read. `enabled` says whether the endpoint is open. Unique: `(gatewayId, plcInstanceId, protocol)`. That an address and port are used by one connection only, and are allowed by the host policy, is kept by the gateway service.

### GatewayTagMapping
`id, gatewayPlcConnectionId, tagId, externalName, accessMode, scalingJson`

One tag the gateway is given. `externalName` is its name in the gateway's register map (the tag's own name by default); `accessMode` is `READ_ONLY` or `READ_WRITE`, the latter only for a command or setpoint tag (kept by the service). The tag keeps its own Modbus area and address. `scalingJson` is unused: the tag's own scale and offset apply. Unique: `(gatewayPlcConnectionId, tagId)`, `(gatewayPlcConnectionId, externalName)`.

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

`scopeType = FACTORY | PLC | IO_MAPPING | MODBUS_MAPPING | DEVICE_PARAMETERS`. `PLC` snapshots are written when a program is deployed; `DEVICE_PARAMETERS` versions (TASK-308) are the parameter sets saved for one device instance (`scopeId` = device id), numbered per device, immutable.

## Process modules

Process modules compose existing factory devices into a process-specific unit. They do not redefine catalog hardware and they reserve no PLC endpoint. Implemented by TASK-601 (migration `process_modules`), except `ModulePlcIoMapping`, which belongs to TASK-605.

### ProcessModuleType
Reusable process template such as PUMP_HOUSE, TANK, MACHINE_CELL, CONVEYOR_CELL, HVAC_LOOP. Shared reference data, like the catalog: not owned by a factory.

`id, code, name, version, description, simulatorModelType, profiles, configSchemaJson, createdAt, updatedAt`

- `profiles`: the selectable variants of the template, e.g. `SINGLE_PUMP`, `DUTY_STANDBY`. A role or signal may apply to some of them only, so the I/O count of a module follows its profile.
- `configSchemaJson`: `{ fields: [{ key, label, type, unit, min, max, options, defaultValue }] }` with `type = number | integer | boolean | text | choice`. It declares what an instance's `configJson` may contain; process-specific settings live there and never as columns.
- `simulatorModelType`: the process model that simulates the type; null until one exists (TASK-602).

Unique: `(code, version)`. A stored version is never changed, because module instances (and later their PLC bindings) refer to its roles and signals; a changed template is a new version.

### ModuleRoleDefinition
A role a factory device plays in a module of the type: the process meaning, separate from the device's manufacturer and model.

`id, processModuleTypeId, key, name, description, deviceCategoryCodes, required, maxDevices, profiles, position`

`deviceCategoryCodes` lists the device categories that can fill the role (empty accepts any). `profiles` empty means every profile. Unique: `(processModuleTypeId, key)`.

This table is an addition to the model planned before Phase 06, which kept the role as a free `roleKey` on `ModuleDevice`. A role has to be declared by the type to be "typed": which categories fit, whether it is required, how many devices it takes.

### ModuleSignalDefinition
Reusable logical I/O contract for a process-module type.

`id, processModuleTypeId, key, name, description, direction, dataType, role, unit, signalType, required, rangeMin, rangeMax, moduleRoleDefinitionId, profiles, position, metadataJson`

`direction = INPUT | OUTPUT | INTERNAL | ALARM` from the PLC/control-program perspective. `dataType` and `role` are the tag enums. `moduleRoleDefinitionId` names the role whose device carries the signal, when it belongs to one. `profiles` empty means every profile. Unique: `(processModuleTypeId, key)`.

A signal definition is logical: it reserves no PLC I/O point, tag or register.

### ProcessModuleInstance
One factory-specific module.

`id, factoryId, processModuleTypeId, name, location, status, profile, configJson, createdAt, updatedAt`

`status` is a `RuntimeState`, `STOPPED` until a process runtime exists. `profile` is one of the type's profiles, null when the type has none. Unique: `(factoryId, name)`. Deleted with its factory; its type cannot be deleted while it exists (`ON DELETE RESTRICT`).

### ModuleDevice
Assigns an existing factory `DeviceInstance` to a role of the module.

`id, processModuleInstanceId, moduleRoleDefinitionId, deviceInstanceId, metadataJson, createdAt`

A device must belong to the same factory as the module. Unique: `(processModuleInstanceId, moduleRoleDefinitionId, deviceInstanceId)`. The row goes with the module or with the device; the device is never changed or deleted through it. A device may have roles in several modules.

### ModulePlcIoMapping (planned, TASK-605)
Binds one logical module signal to the normal PLC/tag/I/O model.

`id, processModuleInstanceId, moduleSignalDefinitionId, plcInstanceId, tagId, plcIoPointId, metadataJson`

The mapping reuses existing tag/I/O compatibility, occupancy, access-mode, protocol-address and register-overlap rules; it never creates a parallel PLC address space. Not part of the schema yet.

### ModuleInterlock
Process-specific interlock/validation metadata.

`id, processModuleInstanceId, code, name, description, expressionJson, severity, enabled`

`expressionJson = { when: [{ signal, operator, value? }], blocks: [signal] }` over the signal keys of the module's profile; `operator = IS_TRUE | IS_FALSE | GT | GE | LT | LE | EQ | NE`. Unique: `(processModuleInstanceId, code)`.

This is configuration/test metadata. Safety-rated behavior is explicitly out of scope.

## Simulation/state/history

### SimulationProfile
Behavior configuration for a device model/instance: constant, ramp, sine, random, scripted, or domain-specific state machine.

`id, deviceModelId, deviceInstanceId, kind, parametersJson` — exactly one of `deviceModelId` / `deviceInstanceId` is set. `kind = CONSTANT | RAMP | SINE | RANDOM | SCRIPTED | STATE_MACHINE`.

How the device simulator reads it (TASK-204): the newest profile of the instance wins over the newest of its model. `STATE_MACHINE` carries the parameter object of the device's behaviour model. `CONSTANT`, `RAMP`, `SINE` and `RANDOM` describe the signal source of a sensor (a switch accepts `CONSTANT`). `SCRIPTED` is not supported yet. Parameters are validated when a simulation starts.

Advanced coupled process-model configuration belongs to `ProcessModuleType/ProcessModuleInstance` (see Process modules above) rather than overloading a single device profile.

### DeviceRuntimeSnapshot
Latest persisted important state; not the live authority. The device simulator overwrites one row per device at its snapshot interval and when it stops; `valuesJson` holds the device's state, faults, inputs and outputs.
`deviceInstanceId, status, valuesJson, quality, capturedAt`

### DeviceCommand
`id, factoryId, targetDeviceId, plcInstanceId, tagId, commandType, requestedValueJson, source, requestedAt, appliedAt, status`

### RuntimeEvent
`id, factoryId, deviceId, type, severity, version, payloadJson, occurredAt`

`version` is the payload-shape version (event payloads are versioned).

Since TASK-401 the id is assigned by the server (UUID v7, strictly increasing within the server process) together with `occurredAt`, so events sort by `(occurredAt, id)` in the order they were recorded. Events written inside a configuration transaction keep the database default. Rows older than `EVENT_RETENTION_DAYS` are deleted.

### AlarmEvent
`id, factoryId, deviceId, code, severity, message, sourceTagId, startedAt, clearedAt, acknowledgedAt`

Written by the event service (TASK-401). `code` is `FAULT:<fault code>` for a simulated device fault, `RUNTIME_FAULT` for a failed PLC runtime, `PLC_LINK_DOWN` for a PLC that does not answer, and `TAG:<tag name>` with `sourceTagId` for an alarm tag set by PLC logic. At most one row per condition has `clearedAt` null; the service enforces this, not a constraint. Who acknowledged is in the `ALARM_ACKNOWLEDGED` event. Cleared rows older than `EVENT_RETENTION_DAYS` are deleted.

### TelemetrySample
`id, factoryId, deviceId, tagId, valueNumber, valueJson, quality, sampledAt`

Written by the tag monitor's sampling rule (TASK-401, `docs/events-telemetry.md` → Telemetry): `valueNumber` is the engineering value, 0 or 1 for a BOOL; `deviceId` is the device the tag carries a signal of, else the PLC. Rows older than `TELEMETRY_RETENTION_HOURS` are deleted. No screen reads them yet.

For high-volume history, partitioning/retention should be introduced first. TimescaleDB may be considered later without changing PostgreSQL as the primary relational store.

## Catalog provenance
Every factual vendor hardware profile keeps source URL plus verification metadata. Never fabricate pinouts, I/O counts, register maps, or electrical limits.

## Implementation (TASK-102)
- Schema: `prisma/schema.prisma`; migrations: `prisma/migrations/` (`init`, `device_io_endpoint`, `factory_subnet_no_overlap`, `plc_api_host_port`, `tag_source_signal`, `catalog_capabilities`, `device_io_simulator_signal`, `device_canvas_position`, `catalog_3d_assets`, `catalog_asset_generation`, `process_modules`, `endpoint_wiring`, `device_capabilities`); generated client: `lib/generated/prisma/` (git-ignored).
- Primary keys are UUID v7 (`@default(uuid(7))`, PostgreSQL `uuid`), except `TelemetrySample.id` (`bigint` identity) and the one-to-one tables keyed by their owner (`ElectricalProfile`, `PlcInstanceProfile`, `DeviceRuntimeSnapshot`).
- Catalog rows referenced by factory data are protected with `ON DELETE RESTRICT`; factory-owned rows cascade from `Factory`.
- `DeviceInstance.dockerContainerId` is server-side only and never sent to the browser.
- Seed: `prisma/seed.ts` (`npm run db:seed`) writes the generic `DeviceCategory` rows and the shipped catalog (`ingestCatalog`, TASK-301), then the shipped process-module types (`ingestModuleTypes`, TASK-601). It is idempotent. Vendor models enter only as verified catalog records.

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
| `Catalog3dAsset_version_check`, `Catalog3dAsset_scale_check` | version >= 1; scale null or positive |
| `Catalog3dAsset_ready_file_check` | a `READY` asset has a storage key, a checksum and a size |
| `DeviceInstance_scene_transform_check` | `sceneScale` between 0.1 and 10, `sceneRotationDeg` from 0 to below 360 |
| `DeviceIoDefinition_max_connections_check`, `CommunicationPort_max_connections_check` | an endpoint takes at least one wire |
| `ProcessModuleType_code_check`, `ProcessModuleType_version_check` | code is capitals, digits and underscores; version >= 1 |
| `ModuleRoleDefinition_max_devices_check` | a role takes at least one device |
| `ModuleSignalDefinition_direction_role_check` | a signal is an `OUTPUT` exactly when its role is `COMMAND` or `SETPOINT` |
| `ModuleSignalDefinition_range_check` | `rangeMin < rangeMax` when both are set |
| `ProcessModuleInstance_name_check` | non-blank module name |

Rules that span tables are enforced in the service layer (`lib/services/`, `lib/validation/`): compact vs modular I/O sources, module/CPU/slot compatibility, signal/point-type compatibility, I/O point ownership and availability, drive → motor categories, multi-word register overlap, process-module same-factory device assignment, required module roles/signals, module-to-PLC mapping compatibility, PLC-to-PLC same-factory validation, client/server role validation, writable-target validation, and inter-PLC register-span compatibility. `lib/db/errors.ts` turns constraint failures into typed domain errors without leaking driver messages.

Wiring: the service layer enforces the rules of one wire (`lib/validation/wiring.ts`) and how many wires an endpoint takes, under a lock on the two devices (`lib/services/wiring-service.ts`); the exclusion constraints above additionally keep a PLC I/O point to one wire.

Process modules: the service layer enforces same-factory device assignment, the categories and number of devices a role takes, roles and signals of the selected profile, configuration against the type's declared fields, and interlocks over the module's own signals (`lib/domain/process-module.ts`, `lib/services/process-module-service.ts`). Module-to-PLC mapping rules follow with `ModulePlcIoMapping` in TASK-605.

The PLC communication tables above are **planned Phase 07 schema**, not yet present in the current Prisma migration. TASK-701/TASK-702 own their implementation and constraints.
