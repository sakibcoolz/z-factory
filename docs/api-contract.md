# Server API Contract

The MVP is one Next.js application. "API" means authenticated server actions and/or route handlers, not a separate backend service.

## Resource groups
- `factories`
- `catalog`
- `devices`
- `racks/modules`
- `io-points`
- `tags`
- `connections`
- `programs/versions`
- `runtime`
- `simulation`
- `gateways/modbus`
- `plc-communications` (Phase 07)
- `events/alarms/telemetry`
- `exports`
- `process-modules` (Phase 06+)
- `process-modules/io-registry` (Phase 06+)

## Commands
- create/update factory
- create/update/remove factory device instance
- install/remove module in rack slot
- connect/disconnect device endpoints
- assign/release PLC I/O point
- create/update tag/register mapping
- compile/deploy/run/stop/restart PLC program
- force permitted simulated input
- write permitted PLC command/setpoint tag
- start/stop/reset/fault-inject simulator devices
- configure gateway-to-PLC mapping
- start/stop/restart factory/device runtime
- generate PLC engineering export
- create/update/remove process-module instance (Phase 06+)
- bind/rebind/release module logical signal to PLC mapping (Phase 06+)
- create/update/remove PLC-to-PLC relationship (Phase 07)
- create/update/remove PLC-to-PLC Modbus mapping (Phase 07)
- enable/disable PLC communication link (Phase 07)
- validate PLC communication mapping (Phase 07)

## Queries
- list/get factories
- browse catalog and compatibility
- get device inspector
- list PLC pins/channels and occupancy
- list tags/register map
- read live tag snapshot
- get runtime/container health
- get topology/connections
- get alarms/events/history
- get export/version metadata
- list/get process modules and assigned devices (Phase 06+)
- get module I/O registry (Phase 06+)
- list PLC communication relationships (Phase 07)
- get PLC communication mapping table (Phase 07)
- get PLC communication health/quality (Phase 07)

## PLC-to-PLC contract
A PLC communication relationship includes:
- source/client PLC
- target/server PLC
- protocol
- endpoint/service name
- port/unit id
- enabled state

Each mapping includes:
- local/source tag
- operation: READ or WRITE
- remote area/address or remote target tag
- data type and word count
- byte/word order
- scaling/unit
- poll/update interval
- quality state

Writes are accepted only for target endpoints configured as writable command/setpoint values. Feedback/status/process-value mappings are read-only.

## Process-module I/O registry invariant
The module registry is a view/binding over the existing PLC tag/I/O/protocol model, not a second PLC address space. Required unmapped signals block runtime start.

## Live channel
SSE is the default server-to-browser event/telemetry transport. WebSockets may be added when justified.

## Mutation invariant
Every mutation validates authorization plus domain invariants before Docker/protocol/runtime side effects. Gateway or PLC-to-PLC writes must not bypass the target PLC's local control logic.

## Implemented

### Authorization boundary (ADR-0007)
Every action and data-loading page calls `requireActor()` and passes the Actor to the service layer. Foreign factories are indistinguishable from missing ones.

### `factories` (TASK-103)
Factory CRUD is owner-scoped and database-backed. Runtime/network/container side effects remain separate from configuration CRUD.

### `tags` and the Modbus map (TASK-203)
Services in `lib/services/tag-service.ts`; every function takes the `Actor` and treats a PLC of another owner as not found.

| Operation | Entry point | Rules |
|---|---|---|
| create tag | `createTag(db, actor, plcId, input)` | strict input; mapping and access mode derived; overlap rejected; bumps the mapping version |
| delete tag | `deleteTag(db, actor, plcId, name)` | bumps the mapping version |
| register map | `getModbusMap(db, actor, plcId)` | the inspector/export contract described in `docs/gateway-modbus.md` |
| live snapshot | `readTags(deps, actor, plcId)`, `readTag(…, name)` | engineering values with quality and timestamp |
| write command/setpoint | `writeTag(deps, actor, plcId, name, value, source)` | only `COMMAND` / `SETPOINT`; recorded as a `DeviceCommand` |
| Modbus endpoint | `configureModbusEndpoint(deps, actor, plcId, { bindAddress, hostPort })` | validated against policy and reservations; requires the runtime to be removed |

### `simulation` (TASK-204)
Services in `lib/services/simulation-service.ts`; dependencies from `getSimulationDeps()`. Every function takes the `Actor`; a factory or device of another owner is not found.

| Operation | Entry point | Rules |
|---|---|---|
| preview | `planSimulation(db, actor, factoryId)` | devices, signal wiring and PLC endpoints the simulator would use; lists skipped devices |
| start | `startFactorySimulation(deps, actor, factoryId)` | every wired PLC needs a configured Modbus endpoint; invalid parameters or wiring refuse the start |
| stop | `stopFactorySimulation(deps, actor, factoryId)` | stores final snapshots |
| live state | `getSimulationState(deps, actor, factoryId)` | from simulator memory, not the database |
| inject / clear fault | `injectDeviceFault`, `clearDeviceFault(deps, actor, deviceId, code)` | fault must be supported by the device type; recorded as events |
| reset device | `resetSimulatedDevice(deps, actor, deviceId)` | refused while a latching fault is still active |
| force simulated input | `forceSimulatedValue(deps, actor, deviceId, value)` | sensors (number) and switches (true/false); `null` releases |

A device signal is wired by creating a tag with `sourceDeviceInstanceId` and `sourceSignal` (`createTag`).
