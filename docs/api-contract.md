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
| create PLC | `createPlc(db, actor, { factoryId, deviceModelId, name, role })` | any programmable controller model (PLC or RTU); name unique in the factory; compact gets built-in I/O points, modular gets its rack |
| delete PLC | `deletePlc(db, actor, plcId)` | refused while a runtime container exists |
| configuration | `getPlcConfiguration(db, actor, plcId)` | hardware, rack and slots, every I/O point with device and tag, peripherals |
| installable modules | `listInstallableModules(db, actor, plcId)` | only modules the catalog allows with the CPU |
| install / remove module | `installModule(…, { moduleModelId, slotIndex })`, `removeModule(…, moduleId)` | compatibility, slot range 1…slot count, slot free; a module in use cannot be removed |
| add a device with its wiring | `addPeripheral(…, { deviceModelId, name, role, assignments })` | creates the device and wires each signal terminal to the given or the first free compatible channel, through the same per-wire function as the wiring service; used by the demo factory and tests, by no screen |
| devices of a factory | `listFactoryDevices(db, actor, factoryId)` | flat, in name order; for the runtime and events screens |
| device hierarchy | `getFactoryDeviceTree(db, actor, factoryId)` | for the factory overview: PLCs as roots, each device once below the PLC it is nearest to and under the device it is reached through; devices with no way to a PLC are roots of their own (`lib/domain/device-tree.ts`) |

Wiring creates a `DeviceConnection` per terminal (`FEEDS_BACK_TO` device → PLC, `CONTROLS` PLC → device) and a tag bound to the I/O point: BOOL or INT16, read-only for gateways, with the device and, for simulated devices, the simulator signal. A protocol device gets one `COMMUNICATES_WITH` connection between ports.

### `topology` (TASK-303)
Services in `lib/services/topology-service.ts`; server actions in `app/factories/[factoryId]/designer/actions.ts`, which return `{ ok, value | message }` to the canvas instead of redirecting. Every function takes the `Actor`.

| Operation | Entry point | Rules |
|---|---|---|
| topology | `getTopology(db, actor, factoryId)` | nodes with position and runtime state; one logical edge per pair for all the wires between two devices (`WIRED_TO`, with each wire pin to pin) and one edge per relationship that is not wiring; palette of catalog models; Z-Factory ids only |
| place device | `placeDevice(…, { deviceModelId, x, y, name? })` | creates the instance (a PLC through `createPlc`); free numbered name when none is given |
| move devices | `moveDevices(…, [{ deviceId, x, y }])` | every device must belong to the factory |
| rename | `renameDevice(db, actor, deviceId, { name, role })` | name unique in the factory; existing tag names are kept |
| delete device | `removeDevice(db, actor, deviceId)` | frees the PLC channels it used and their tags first; a PLC goes through `deletePlc` |
| link | `linkDevices(…, { fromId, toId, kind? })` | relationship derived by `linkOptions`; returns `CHOOSE` with options when several apply, and `WIRE` when the two are to be wired pin by pin: nothing is stored until a wire is (`wiring` below); a port link is a wire between two ports within what each port takes |
| unlink | `unlinkDevices(…, { sourceId, targetId, relationship })` | a relationship edge is removed as one; `WIRED_TO` removes every wire between the two devices |

### `device screens` (TASK-308)
Services in `lib/services/device-detail-service.ts`; server action in `app/factories/[factoryId]/devices/[deviceId]/actions.ts`. Every function takes the `Actor`; a device of another owner is not found.

| Operation | Entry point | Rules |
|---|---|---|
| device detail | `getDeviceDetail(db, actor, deviceId)` | identity, capabilities, the screens the model has (`deviceSections`), ports, wires, the controller tags carrying its signals (registers), parameters with their versions |
| is controller | `isControllerDevice(db, actor, deviceId)` | a programmable controller's screens are the PLC screens |
| save parameters | `saveDeviceParameters(db, actor, deviceId, values)` | model must be `PARAMETER_CONFIGURABLE` (`parameters-capability`) and have a parameter set (`parameters-undefined`); only its fields (`parameters-field`); values validated by the behaviour model (`simulation-params`); one immutable `ConfigurationVersion` per save; the device's simulation profile takes the values |

Program workflow (`plc-runtime-service.ts`): `createProgramVersion`, `checkProgram` and `deployProgramVersion` refuse a model that is not `PROGRAMMABLE` + `IEC_61131_3` on the OpenPLC adapter (`program-capability`) and a program that is not Structured Text (`program-language`), before any side effect. `createPlc` and `listPlcModels` accept any programmable controller model (PLC or RTU).


Services in `lib/services/wiring-service.ts`; server actions in `app/factories/[factoryId]/designer/actions.ts`. Every function takes the `Actor`; a factory of another owner is not found, and a device of another factory is not a device of this one. Rules in `lib/validation/wiring.ts`.

An endpoint is `{ deviceId, type, id }` with `type = DEVICE_IO | PLC_IO_POINT | PROTOCOL_PORT` and the id of the terminal definition, the I/O point or the port.

| Operation | Entry point | Rules |
|---|---|---|
| endpoints of two devices | `getPairWiring(db, actor, factoryId, firstId, secondId, replacingWireId?)` | every endpoint of both with what it is and the wires on it; the wires between the two; for every pair of endpoints the refusal, if any. With `replacingWireId` the ends of that wire count as free |
| add a wire | `connectWire(db, actor, factoryId, { from, to })` | one wire between two exact endpoints; refused wiring is never stored; a wire to a PLC channel creates its tag at the channel's address |
| move a wire | `reconnectWire(db, actor, factoryId, wireId, { from, to })` | the new wire is validated first; old and new change in one transaction or not at all |
| remove a wire | `disconnectWire(db, actor, factoryId, wireId)` | a PLC channel is free again and its tag removed; the devices stay |
| remove all wires of two devices | `disconnectDevices(db, actor, factoryId, firstId, secondId)` | what removing a wiring edge does; port links are not wires of that edge |

Refusals carry `details.rule`, `details.from` and `details.to`: `wire-same-device` (VALIDATION), `wire-kind`, `wire-direction`, `wire-signal-class`, `wire-signal-type`, `wire-protocol`, `wire-plc-to-plc` (INCOMPATIBLE), `wire-duplicate` (CONFLICT), `wire-occupied` (OCCUPIED_ENDPOINT). The message names both endpoints, e.g. `PT-102 / OUT is 4–20 mA; PLC-01 / AI 0 takes 0–10 V.`

`unwireDevice` (`lib/services/plc-config-service.ts`) removes every wire between a PLC and one device; deleting a device uses it.

### `process-modules` (TASK-601)
Services in `lib/services/process-module-service.ts`. Module types are shared reference data, not owned by a factory. Every function on a module takes the `Actor`; a module, factory or device of another owner is not found. There is no screen, route or server action yet (TASK-604), and no PLC binding (`process-modules/io-registry`, TASK-605).

| Operation | Entry point | Rules |
|---|---|---|
| module types | `listModuleTypes(db)` | every stored version; the newest of each code is `latest` |
| module type | `getModuleType(db, typeId)` | profiles, configuration fields, roles, signals, signal counts per direction |
| define type | `defineModuleType(db, definition)` | checked by `parseModuleType`; a `(code, version)` is stored once and never changed |
| list modules | `listModules(db, actor, factoryId)` | name order; profile, type, device count, signal counts, `complete` and issues |
| module | `getModule(db, actor, moduleId)` | roles of the profile with their devices, signals of the profile, configuration, interlocks, issues |
| create module | `createModule(db, actor, { factoryId, typeId, name, location?, profile?, config? })` | name unique in the factory; profile one of the type's (its first by default); configuration checked against the type and filled with defaults |
| update module | `updateModule(db, actor, moduleId, { name?, location?, profile?, config? })` | a given `config` replaces the stored one; a profile is refused while a device or interlock has no place in it |
| delete module | `deleteModule(db, actor, moduleId)` | removes assignments and interlocks; devices stay |
| assign device | `assignModuleDevice(db, actor, moduleId, { roleKey, deviceId })` | same factory; category accepted by the role; role in the profile; a free place in the role; the device is not changed |
| unassign device | `unassignModuleDevice(db, actor, moduleId, assignmentId)` | the device stays in the factory |
| add interlock | `addModuleInterlock(db, actor, moduleId, { code, name, description?, severity?, enabled?, expression })` | conditions and blocked outputs must be signals of the module's profile, each read as its data type |
| update / remove interlock | `updateModuleInterlock(…, interlockId, changes)`, `removeModuleInterlock(…, interlockId)` | the code is fixed; what is left out stays |

Refusals carry a rule in `details.rule`: `module-profile`, `module-config`, `module-device-factory`, `module-role-category`, `module-role-profile`, `module-role-full`, `module-profile-in-use`, `module-interlock`, `module-type-version`.

Writing the shipped types is not an API: `ingestModuleTypes(db, loadModuleTypes())` runs from `npm run db:seed`.

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
| stream | `openLiveStream(deps, actor, factoryId, lastEventId, send)` | replay, snapshot, then live; every recorded event is followed by a `devices` message with the resulting device states; returns the function that ends it |

| Route | Returns |
|---|---|
| `GET /factories/[factoryId]/stream` | the server-sent event stream described in `docs/events-telemetry.md`; `Last-Event-ID` header or `?lastEventId=` resumes; 404 for an unknown or foreign factory |

| Action (`app/factories/[factoryId]/live-actions.ts`) | Effect |
|---|---|
| `writeTagAction(factoryId, plcId, tagName, …)` with `value` | `writeTag` with source `UI`: `true` / `false` for a BOOL, a number otherwise; only command and setpoint tags |
| `acknowledgeAlarmAction(factoryId, alarmId, …)` | `acknowledgeAlarm` |

The stream is one-way. Nothing is written through it.

### `catalog 3D assets` and the `scene` (TASK-402, ADR-0012)
Services in `lib/services/asset-service.ts` and `lib/services/scene-service.ts`.

| Operation | Entry point | Rules |
|---|---|---|
| register an asset | `registerCatalogAsset({ db, storage }, { deviceModelId, provider, providerJobId?, scale?, rotationYDeg? }, glb)` | server-side authoring only, not reachable from a request; validates the GLB, stores it as the model's next version and makes it active; a refused file changes nothing |
| asset versions | `listCatalogAssets(db, deviceModelId)` | newest first, with which one is active |
| asset file | `readCatalogAsset({ db, storage }, assetId)` | only a `READY` version; a record without its file is not found |
| factory scene | `getFactoryScene(db, actor, factoryId)` | devices, connections and states of `getTopology`, plus position on the floor, the model's asset, the instance's rotation and scale, the category's placeholder, and per connection its stored conductors (the wires of a wiring edge; none for a relationship) (TASK-405) |
| place in scene | `setDeviceSceneTransform(db, actor, deviceId, { rotationDeg, scale })`, `changeDeviceSceneTransform(…, change)` | appearance only; scale 0.25 to 4 |

| Route | Returns |
|---|---|
| `GET /assets/models/[assetId]/model.glb` | the GLB (`model/gltf-binary`), `Cache-Control: private, max-age=31536000, immutable`, ETag from the checksum; 304 on a matching `If-None-Match`; 404 for an unknown, malformed or not-ready asset and for a missing file |

| Action (`app/factories/[factoryId]/view-3d/actions.ts`) | Effect |
|---|---|
| `sceneTransformAction(factoryId, …)` with `deviceId`, `operation` = `rotate-left` \| `rotate-right` \| `scale-up` \| `scale-down` \| `reset` | one step of 45° or ×1.25 from where the device is |

### `catalog 3D asset authoring` (TASK-403)
Not an API of the application: these functions are called by `scripts/catalog-assets.ts` (`npm run assets`) on the server and by nothing a browser can reach. Services in `lib/services/asset-authoring-service.ts` and `lib/services/asset-service.ts`; the provider is injected (`AssetProvider`, `lib/assets/meshy.ts`).

| Operation | Entry point | Rules |
|---|---|---|
| plan | `listAssetPlan(db)`, `getAssetPlanEntry(db, modelId, hint?)` | every catalog model with its prompt, shape key, space and current asset |
| cost preview | `previewGeneration(db, { deviceModelId, … })` | what would be requested and the credits it is expected to cost; requests nothing |
| generate | `generateCatalogAsset(deps, { deviceModelId, aiModel?, targetPolycount?, textured?, hint?, upAxis?, yawDeg? })` | opens a pending version, runs the provider's jobs, downloads, normalizes, checks, registers; a failure is recorded on the version; refused while the model has a pending job |
| resume | `resumeCatalogAsset(deps, assetId)` | continues a pending version from its stored job ids; requests nothing twice |
| import | `importCatalogAsset({ db, storage }, { deviceModelId, provider?, providerJobId?, upAxis?, yawDeg? }, glb)` | a file from elsewhere: normalized, checked and registered as the next version; a refused file changes nothing |
| share | `shareCatalogAsset({ db, storage }, { sourceAssetId, deviceModelId })`, `findShareableAsset(db, modelId)` | copies a ready file to another model as that model's own version, fitted into its category's space |
| job states | `openCatalogAssetJob`, `recordCatalogAssetJob`, `failCatalogAssetJob`, `completeCatalogAssetJob` | only a pending version changes; completing stores the file and makes the version active in one transaction |
| retire | `retireCatalogAsset({ db, storage }, assetId, { purge?, reason? })` | the version is no longer rendered or served; the newest other ready version becomes active, else none; `purge` deletes the file |
| activate | `activateCatalogAsset({ db, storage }, assetId)` | only a ready version whose file exists |

`getCatalogOverview` and `getCatalogModel` report the result: per model `asset: { state: READY | PENDING | FAILED | NONE, activeVersion }`, per model detail every version with status, source, provider status and message, and `totals.withAsset`.

### `gateways` (TASK-501, ADR-0013)
Services in `lib/services/gateway-service.ts`; dependencies from `getGatewayDeps()`; server actions in `app/factories/[factoryId]/gateways/actions.ts`, which stay on the page and return `{ notice?, message? }`. A factory, gateway or connection of another owner is not found.

| Operation | Entry point | Rules |
|---|---|---|
| view | `getGatewaysView(deps, actor, factoryId)` | gateways with connections, mappings, unmapped tags, endpoint state and counters; the addresses and port range the host allows; brings the endpoints in line first |
| add gateway | `addGateway(deps, actor, factoryId)` | a device from the catalog's gateway model with the next free name |
| connect | `connectGateway(deps, actor, gatewayDeviceId, { plcId, host, port, unitId?, pollIntervalMs? })` | gateway device and PLC of the same factory; address allowed, port in range and free; one connection per gateway and PLC; opens the endpoint |
| enable / disable | `setGatewayConnectionEnabled(deps, actor, connectionId, enabled)` | opens or closes the endpoint; mappings are kept |
| remove | `removeGatewayConnection(deps, actor, connectionId)` | closes the endpoint; mappings go with it |
| map tag | `mapGatewayTag(deps, actor, connectionId, { tagId, access?, externalName? })` | a tag of the connected PLC; `READ_WRITE` only for a command or setpoint tag; mapping again changes access or name |
| map all | `mapAllGatewayTags(deps, actor, connectionId)` | commands and setpoints writable, everything else to read |
| unmap | `unmapGatewayTag(deps, actor, connectionId, mappingId)` | takes effect at once |
| register map | `getGatewayMap(deps, actor, connectionId)` | the document an edge device is configured from |
| endpoints | `syncGatewayEndpoints(deps, factoryId)` | opens enabled connections, closes the others, takes over changed mappings; stores the gateway's state (`RUNNING`, `STOPPED`, `FAULTED`) |

| Route | Returns |
|---|---|
| `GET /factories/[factoryId]/gateways/[connectionId]/map.json` | the register map as an attachment, `Cache-Control: no-store`; 404 for an unknown or foreign connection |

| Action | Effect |
|---|---|
| `addGatewayAction(factoryId, …)` | `addGateway` |
| `connectGatewayAction(factoryId, gatewayDeviceId, …)` with `plcId`, `host`, `port`, `unitId`, `pollIntervalMs` | `connectGateway` |
| `gatewayConnectionAction(factoryId, connectionId, …)` with `operation` = `enable` \| `disable` \| `remove` \| `map-all` \| `unmap:<mapping id>` | the matching function |
| `mapGatewayTagAction(factoryId, connectionId, …)` with `tagId`, `access`, `externalName` | `mapGatewayTag` |

The endpoint itself is not an HTTP API: it speaks Modbus TCP to the edge device (`docs/gateway-modbus.md` → gateway endpoints).

### `factory lifecycle` and the `demo factory` (TASK-502)
| Operation | Entry point | Rules |
|---|---|---|
| start factory | `startFactory(deps, actor, factoryId)` in `lib/services/factory-runtime-service.ts` | every PLC runtime in name order (one that runs is left alone), then live monitoring, the device simulation and the gateway endpoints; a PLC that does not start stops the sequence; a simulation that cannot start is reported, not an error |
| stop factory | `stopFactory(deps, actor, factoryId)` | the simulation first (last states stored), then every started PLC; containers are stopped, not removed; gateway endpoints stay open |
| demo factory | `createDemoFactory(deps, actor, { subnetCidr?, gatewayHost? })` in `lib/services/demo-service.ts` | builds the pump station of `docs/demo-runbook.md` from catalog models with the services the screens use; starts nothing; a second one is named "Pump Station Demo 2" |

Dependencies from `getFactoryRuntimeDeps()` and `getGatewayDeps()`.

| Action | Effect |
|---|---|
| `factoryRuntimeAction(factoryId, …)` with `operation` = `start` \| `stop` (`app/factories/[factoryId]/runtime/actions.ts`) | `startFactory` / `stopFactory`; answers when the operation has finished |
| `createDemoFactoryAction(…)` (`app/factories/actions.ts`) | `createDemoFactory`, then opens the new factory's Runtime screen |
