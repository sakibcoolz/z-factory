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

| simulator screen | `getSimulationView(deps, actor, factoryId)` | every simulated device with its command and feedback signals, wired tags, faults and, while running, live values; says what blocks a start |

A device signal is wired by creating a tag with `sourceDeviceInstanceId` and `sourceSignal` (`createTag`).

### `catalog` (TASK-301)
Services in `lib/services/catalog-service.ts`. The catalog is shared reference data, not owned by a factory.

| Operation | Entry point | Returns |
|---|---|---|
| overview | `getCatalogOverview(db)` | manufacturer › family › model tree, categories with models, totals |
| model | `getCatalogModel(db, modelId)` | identity, source, supply, ports, built-in I/O or terminals, facts; rack and installable modules for a modular PLC |
| peripherals of a PLC | `listCompatiblePeripherals(db, plcModelId, { compatibleOnly })` | per peripheral model: the PLC point class each terminal needs, whether it fits (built-in channels or installable modules), and shared protocols |

Writing the catalog is not an API: `ingestCatalog(db, loadCatalog())` runs from `npm run db:seed`.

### `plc configuration` (TASK-302)
Services in `lib/services/plc-config-service.ts`; server actions in `app/factories/[factoryId]/plcs/actions.ts`. Every function takes the `Actor`; a PLC of another owner is not found.

| Operation | Entry point | Rules |
|---|---|---|
| PLC models for the form | `listPlcModels(db, architecture)` | catalog PLC models of one architecture |
| create PLC | `createPlc(db, actor, { factoryId, deviceModelId, name, role })` | name unique in the factory; compact gets built-in I/O points, modular gets its rack |
| delete PLC | `deletePlc(db, actor, plcId)` | refused while a runtime container exists |
| configuration | `getPlcConfiguration(db, actor, plcId)` | hardware, rack and slots, every I/O point with device and tag, peripherals |
| installable modules | `listInstallableModules(db, actor, plcId)` | only modules the catalog allows with the CPU |
| install / remove module | `installModule(…, { moduleModelId, slotIndex })`, `removeModule(…, moduleId)` | compatibility, slot range 1…slot count, slot free; a module in use cannot be removed |
| addable peripherals | `listAddablePeripherals(db, actor, plcId)` | each catalog peripheral with whether the PLC has room now, and why not |
| options for one model | `getPeripheralOptions(db, actor, plcId, deviceModelId)` | suggested name; per terminal the free compatible channels |
| add peripheral | `addPeripheral(…, { deviceModelId, name, role, assignments })` | creates the device, wires each terminal, creates tags; all or nothing |
| remove peripheral | `removePeripheral(db, actor, plcId, deviceId)` | frees channels, deletes their tags and the device |
| devices of a factory | `listFactoryDevices(db, actor, factoryId)` | for the factory overview |

Wiring creates a `DeviceConnection` per terminal (`FEEDS_BACK_TO` device → PLC, `CONTROLS` PLC → device) and a tag bound to the I/O point: BOOL or INT16, read-only for gateways, with the device and, for simulated devices, the simulator signal. A protocol device gets one `COMMUNICATES_WITH` connection between ports.

### `topology` (TASK-303)
Services in `lib/services/topology-service.ts`; server actions in `app/factories/[factoryId]/designer/actions.ts`, which return `{ ok, value | message }` to the canvas instead of redirecting. Every function takes the `Actor`.

| Operation | Entry point | Rules |
|---|---|---|
| topology | `getTopology(db, actor, factoryId)` | nodes with position and runtime state, one typed edge per relationship between two devices, palette of catalog models; Z-Factory ids only |
| place device | `placeDevice(…, { deviceModelId, x, y, name? })` | creates the instance (a PLC through `createPlc`); free numbered name when none is given |
| move devices | `moveDevices(…, [{ deviceId, x, y }])` | every device must belong to the factory |
| rename | `renameDevice(db, actor, deviceId, { name, role })` | name unique in the factory; existing tag names are kept |
| delete device | `removeDevice(db, actor, deviceId)` | frees the PLC channels it used and their tags first; a PLC goes through `deletePlc` |
| link | `linkDevices(…, { fromId, toId, kind? })` | relationship derived by `linkOptions`; returns `CHOOSE` with options when several apply; all connection rules enforced |
| unlink | `unlinkDevices(…, { sourceId, targetId, relationship })` | a wired edge removes the device's whole wiring to that PLC |

`wireExistingDevice` and `unwireDevice` (`lib/services/plc-config-service.ts`) wire and unwire a device that already exists, with the same checks as adding a peripheral.

### `plc export` (TASK-304)
Service: `buildPlcExport(db, actor, plcId, { includeRuntime })` in `lib/services/plc-export-service.ts`, returning the document described in `docs/plc-export.md`.

| Route | Returns |
|---|---|
| `GET /factories/[factoryId]/plcs/[plcId]/export/files/plc.json` | the export document (`?runtime=1` adds the stored runtime state) |
| `GET …/export/files/io.csv`, `tags.csv`, `devices.csv` | CSV schedules |

Attachments with `Cache-Control: no-store`. 404 for an unknown file, a malformed id, a PLC of another factory or owner; 500 without detail when the redaction check stops an export.

### `program`, `runtime` and `simulator` screens (TASK-305)
Server actions. Each passes `requireActor()` first, stays on the page and returns `{ notice?, message?, diagnostics?, savedVersion? }` (`lib/plc/operation-state.ts`): what happened, or why it did not. They answer when the operation has finished; starting a runtime can take minutes.

| Action | Input | Effect |
|---|---|---|
| `programAction(factoryId, plcId, …)` | `intent` = `check` \| `save` \| `deploy`, `sourceText` | `checkProgram`, `createProgramVersion` or `saveAndDeployProgram`; CRLF line ends are stored as LF; compiler findings come back as `diagnostics` |
| `programVersionAction(factoryId, plcId, versionId, …)` | `operation` = `select` \| `deploy` | `selectProgramVersion` or `deployProgramVersion` for that version |
| `runtimeAction(factoryId, plcId, …)` | `operation` = `start` \| `deploy` \| `restart` \| `stop` \| `remove` \| `refresh` | the matching function of the PLC runtime service |
| `simulationAction(factoryId, …)` | `operation` = `start` \| `stop` | `startFactorySimulation` / `stopFactorySimulation` |
| `deviceFaultAction(factoryId, deviceId, …)` | `operation` = `inject:<code>` \| `clear:<code>` \| `reset` | fault injection, clearing or operator reset on one simulated device; recorded as events |

The first two live in `app/factories/[factoryId]/plcs/runtime-actions.ts` with `runtimeAction`, the last two in `app/factories/[factoryId]/simulator/actions.ts`. None of them writes a PLC tag: the simulator actions act on the simulated equipment, and PLC logic stays the only source of device commands.

Read models: `getPlcProgramView`, `getPlcVersionsView`, `getPlcRuntimeView` and `readLivePlcState` (`lib/services/plc-runtime-view-service.ts`, see `docs/openplc-runtime.md`), and `getSimulationView`. A PLC or factory of another owner is not found.

### `events`, `alarms` and the live channel (TASK-401)
Services in `lib/services/event-service.ts` and `lib/services/live-service.ts`; dependencies from `getLiveDeps()`. A factory, PLC or alarm of another owner is not found.

| Operation | Entry point | Rules |
|---|---|---|
| record events | `recordEvents(deps, events)`, `recordEvent` | the only way a runtime event is recorded; assigns id and time, applies alarm rules, publishes |
| event history | `listEvents(db, actor, factoryId, { family, severities, deviceId, limit })` | newest first, at most 500 |
| alarms | `listAlarms(db, actor, factoryId)` | active alarms, then the 25 most recently cleared |
| acknowledge | `acknowledgeAlarm(deps, actor, alarmId)` | once per alarm; recorded with the actor |
| live tags | `getLiveTags(deps, actor, factoryId)` | every tag of the factory's PLCs with its reading from the monitor's memory |
| device states | `getDeviceStates(deps, factoryId)` | simulator memory while a simulation runs; otherwise marked as snapshot or stored |
| monitoring | `syncFactoryMonitoring(deps, factoryId)`, `stopPlcMonitoring(deps, actor, plcId)` | one pass at a time per factory |
| stream | `openLiveStream(deps, actor, factoryId, lastEventId, send)` | replay, snapshot, then live; returns the function that ends it |

| Route | Returns |
|---|---|
| `GET /factories/[factoryId]/stream` | the server-sent event stream described in `docs/events-telemetry.md`; `Last-Event-ID` header or `?lastEventId=` resumes; 404 for an unknown or foreign factory |

| Action (`app/factories/[factoryId]/live-actions.ts`) | Effect |
|---|---|
| `writeTagAction(factoryId, plcId, tagName, …)` with `value` | `writeTag` with source `UI`: `true` / `false` for a BOOL, a number otherwise; only command and setpoint tags |
| `acknowledgeAlarmAction(factoryId, alarmId, …)` | `acknowledgeAlarm` |

The stream is one-way. Nothing is written through it.
