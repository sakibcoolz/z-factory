# Database Design

Planned database: PostgreSQL with Prisma.

## Core entities

### User
Identity/ownership.

### Factory
`id, ownerId, name, slug, status, runtimeStatus, subnetCidr, createdAt, updatedAt`

### Manufacturer
`id, name, websiteUrl`

### DeviceFamily
`id, manufacturerId, name, deviceType`

### DeviceModel
`id, familyId, modelName, sku, architectureType, runtimeSupport, sourceUrl, sourceRevision, verifiedAt`

`architectureType`: `COMPACT | MODULAR`

`runtimeSupport`: `OPENPLC | MODBUS_SIM | NONE` for MVP-era catalog records.

### ElectricalProfile
`deviceModelId, supplyType, nominalVoltage, voltageMin, voltageMax, notes`

### CommunicationPort
`id, deviceModelId, name, physicalType, protocols, portCount, notes`

### BuiltInIoChannel
Used for compact PLCs.
`id, deviceModelId, ioType, channelIndex, terminalLabel, signalType, addressHint, electricalLimits`

### RackProfile
Used for modular PLCs.
`id, deviceModelId, name, slotCount, reservedSlots, maxExpansion`

### ModuleModel
`id, manufacturerId, family, modelName, sku, moduleType, sourceUrl`

### ModuleCompatibility
`id, cpuModelId, moduleModelId, rule, notes`

### ModuleChannel
`id, moduleModelId, ioType, channelIndex, terminalLabel, signalType, electricalLimits`

### FactoryDevice
An instantiated device in a factory.
`id, factoryId, deviceModelId, name, runtimeType, runtimeStatus, dockerContainerId, virtualIp, hostName`

### FactoryRack / FactoryModule
Stores a selected rack and slot/module placement for modular PLC instances.

### Tag
`id, factoryDeviceId, name, dataType, access, logicalAddress, modbusArea, modbusAddress, scale, unit`

### DeviceConnection
`id, factoryId, sourceDeviceId, targetDeviceId, connectionType, protocol, sourcePort, targetPort, metadata`

### RuntimePort
`id, factoryDeviceId, protocol, containerPort, hostPort, bindAddress`

### SimulationProfile
Behavior configuration for sensors/VFDs: constant, ramp, sine, random, scripted.

### RuntimeEvent
`id, factoryId, deviceId, type, severity, payloadJson, occurredAt`

## Catalog provenance rule
Every factual vendor hardware profile must keep source URL plus verification metadata. Never fabricate pinouts or I/O counts.

## Compact vs modular rule
Compact models expose built-in channels directly. Modular models expose CPU/rack/slot compatibility; I/O channels come from installed modules, not the CPU unless explicitly documented.
