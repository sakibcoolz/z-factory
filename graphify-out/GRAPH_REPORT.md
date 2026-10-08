# Graph Report - z-factory  (2026-10-08)

## Corpus Check
- 703 files · ~513,105 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5823 nodes · 15666 edges · 295 communities (248 shown, 34 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 121 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `5a5b9039`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- module-io-service.ts
- devDependencies
- Engine
- Factory/runtime entities
- module-forms.tsx
- compilerOptions
- telemetry.ts
- process-module-service.ts
- Device Simulation
- UX / Design Specification
- Architecture
- plc-runtime-view-service.ts
- OpenPLC Runtime
- docs/README.md
- Device Catalog
- Docker Runtime Design
- TASK-104 — UI Shell & Wireframe Screens
- External Gateway & Modbus TCP
- Events and Telemetry
- PLC Engineering Export / Print
- telemetry-service.ts
- asset-authoring-service.ts
- scene.test.ts
- lib/services/live-service.ts
- Implemented
- topology-canvas.tsx
- Z-Factory AI Agent Contract
- wiring-editor.tsx
- dev-stack.sh
- TASK-003 — Development Bootstrap Specification
- TASK-204 — Device Simulator Runtime
- TASK-301 — Device Catalog & Provenance
- TASK-302 — Compact & Modular PLC Configuration
- gateway-endpoint/runtime.ts
- Z-Factory
- ADR-0001 — Single Next.js Application for MVP
- dependencies
- TASK-001 — Documentation Baseline
- TASK-002 — Linear Project & Task Sync
- TASK-101 — Bootstrap Next.js
- TASK-102 — Prisma & Domain Foundation
- TASK-202 — OpenPLC Runtime Adapter
- TASK-304 — PLC Engineering Export
- TASK-502 — End-to-End MVP Demo
- site-service.ts
- device-sim/engine.ts
- layout.tsx
- ADR-0002 — OpenPLC as First PLC Runtime
- ADR-0003 — Explicit Compact vs Modular PLC Modeling
- ADR-0004 — Docker Engine API Orchestration
- ADR 0005 — Runtime State and Device Simulation
- ADR 0006 — Gateway Commands Preserve PLC Control Authority
- TASK-103 — Factory CRUD
- TASK-201 — Docker Engine Integration
- TASK-203 — Modbus Mapping & External Ports
- TASK-303 — React Flow Factory Topology
- TASK-401 — Events & Live Telemetry
- TASK-402 — Three.js Factory View
- TASK-501 — Industrial Edge / Raspberry Pi Connectivity
- Phase 00 — Documentation & Foundation
- CLAUDE.md
- CODEX.md
- phase-01-core-platform/README.md
- phase-02-openplc-runtime/README.md
- phase-03-factory-designer/README.md
- Phase 04 — Events, Telemetry & 3D
- phase-05-external-gateway/README.md
- copilot-instructions.md
- next.config.ts
- postcss.config.mjs
- Batch
- lib/domain/errors.ts
- simulation-service.ts
- device-tree.tsx
- stored-device.tsx
- ADR 0007 — Single-Owner Mode Behind One Authorization Boundary
- event-service.ts
- testing.T
- topology-service.ts
- device-detail-service.ts
- [architecture]/page.tsx
- adapter.ts
- Process Modules
- scene-view.tsx
- FactorySimulation
- strucpp-worker.mjs
- .prettierrc.json
- openplc-adapter.test.ts
- plc-config-service.ts
- TASK-605 — Module PLC I/O Registry & Allocation
- ADR 0008 — Post-MVP Go Process Simulation Service
- TASK-603 — Simulator / Modbus Closed-Loop Bridge
- TASK-702 — Modbus TCP Client/Server Mapping
- TASK-703 — PLC-to-PLC Runtime Adapter & Docker Networking
- connection-service.ts
- Phase 06 — Process Module Framework & Go Simulation Service
- TASK-601 — Process Module Domain & Persistence
- TASK-602 — Go Simulation Service Foundation
- TASK-604 — Process Module Designer & Validation
- Phase 07 — PLC-to-PLC Communication
- TASK-701 — PLC Relationship & Communication Domain
- TASK-704 — PLC-to-PLC UI, Validation & E2E Tests
- ADR 0009 — OpenPLC Runtime v4 Image and the STruC++ Compile Step
- stored-screens.tsx
- domain/scenario.ts
- Deployment
- authoring.test.ts
- domain/plc-communication.ts
- Server
- scripts
- process-bridge-service.ts
- process-bridge/runtime.ts
- siemens.ts
- plc-report.tsx
- TASK-206 — Remove a Factory's Docker Network and PLC Containers When It Is Deleted
- TASK-503 — Z-Factory Thin Client Agent: File-Driven Dynamic PLC Connectivity, Concurrency & MQTT Cloud Uplink
- package.json
- ADR 0010 — In-Process Device Simulator and PLC Bridge
- catalog-service.ts
- catalog/schema.ts
- factory-canvas.tsx
- mqtt/runtime.ts
- plc-communication-service.ts
- process-modules/schema.ts
- plc-communication.tsx
- plc-runtime-service.ts
- getDb
- getDb
- Server
- wiring-service.ts
- SignalState
- [agentId]/page.tsx
- Catalog Sources
- routes.ts
- gateway-service.ts
- containers.ts
- Testing Strategy
- Programmable Devices — End-to-End Model
- MVP 2 scope
- events.ts
- TASK-305 — Stored PLC Program, Versions, Runtime & Simulator Screens
- Observer
- MVP Demo Runbook — Pump Station
- TASK-207 — Check a Factory's Subnet Against Existing Docker Networks
- PlcLinkMonitorRuntime
- edge-client.mjs
- lib/db/client.ts
- DeviceSimulatorRuntime
- normalize.ts
- factory-service.ts
- tag-monitor/monitor.ts
- Agent
- TASK-403 — Meshy MCP Catalog 3D Asset Generation
- Catalog entities
- compilerOptions
- telemetry-e2e.test.ts
- TASK-404 — Live 3D Runtime-State Visualization
- ADR 0011 — Live Channel: SSE, In-Process Tag Monitor and Replay by Event Order
- prisma
- requireActor
- commands.ts
- New
- TASK-208 — "Stop Factory" Must Leave a Factory Stopped After a Failed Start
- dependencies
- domain/process-module.ts
- devDependencies
- Edge Deployment — Thin Client Agent in Production
- Process modules
- time.Time
- parseInput
- ADR 0012 — Catalog 3D Assets: Record in PostgreSQL, File in a Server Directory
- model.go
- TASK-205 — Program-Authoritative I/O Semantics & Physical Target Boundary
- modbus/client.ts
- live.ts
- config.go
- context.Context
- bridge.ts
- TASK-209 — Reconcile Stored Runtime State With Docker After a Host Restart
- OpenPlcClient
- Security Model
- catalog/catalog.test.ts
- telemetry-chart.tsx
- domain/simulation.ts
- ADR 0013 — External Gateways Connect to a Filtering Modbus Endpoint
- tag-authority.ts
- Store
- TASK-307 — Pin-to-Pin Wiring Editor & Validation
- Process Simulation Service
- TASK-306 — Factory Overview Device Hierarchy
- TASK-405 — 3D Physical Conductor Rendering
- plc-config-view.ts
- TASK-309 — Retire Design Fixtures
- Phase 08 — Simulation Control, Overrides & Closed-Loop Testing
- TASK-308 — Capability-Driven Programmable Device UI & Runtime
- Uplink
- ADR-0015 — PLC Scan-Cycle Authority and Physical I/O Boundary
- ADR 0014 — One Wire Between Two Exact Endpoints Is the Only Source of Wiring
- runtime-state.ts
- edge-deployment-service.ts
- topology.ts
- Simulation/state/history
- process-sim/README.md
- github.com/sakibcoolz/z-factory/services/process-sim
- TASK-801 — Simulation Override Runtime Contract & Go API
- TASK-804 — Closed-Loop Test Scenarios, Events & E2E Validation
- catalog-view.tsx
- TASK-802 — Simulation Override UI & Operator Controls
- TASK-803 — PLC Output → Simulator Command Bridge
- TASK-901 — Web Factory TypeScript Cloud Foundation & Identity Model
- TASK-902 — MQTT Broker Integration, Agent Onboarding & Connectivity
- TASK-903 — Telemetry Ingestion, Cloud Persistence & Latest-State Projection
- TASK-904 — Web Factory Live Monitoring, Dashboards, Events & Alarms
- TASK-905 — Remote Command/Setpoint Lifecycle, Authorization & Audit
- TASK-906 — Production Edge Deployment, Resilience, Security & Physical E2E
- Database Design
- user-service.ts
- Tank
- install.sh
- PLC-to-PLC communication (Phase 07)
- connectivity.ts
- factory-crud.test.ts
- meshy.ts
- scripts
- TASK-907 — Recheck Command Expiry Immediately Before the PLC Write
- ADR-0021 — Monitoring: Alarms and Live Updates
- asset-authoring.test.ts
- Coding Standards
- ADR-0023 — Production Edge Deployment and Transport Security
- ADR-0016 — PLC-to-PLC Client Runs in the Client PLC's Runtime
- scenario-service.ts
- communication/actions.ts
- PumpHouse
- Web Factory
- test-packaging.sh
- edge-standin.sh
- build.sh
- web-factory/package.json
- Z-Factory Thin Client Agent
- next-auth.d.ts
- dev-ca.sh
- ADR-0017 — Thin Client Agent Runs From Exported Files
- ADR-0022 — Cloud Commands and Setpoints
- zfactory-thin-client-agent/README.md
- github.com/sakibcoolz/z-factory/services/zfactory-thin-client-agent
- ADR-0018 — Web Factory Identity, Sign-in and Data Ownership
- gateway.ts
- DomainError
- PLC & Industrial Device Source/Data Policy
- health/route.ts
- events.test.ts
- web-factory/app/layout.tsx
- web-factory/next.config.ts
- web-factory/README.md
- tailwindcss
- @types/pg
- @types/three
- @vitejs/plugin-react
- { GET, POST }
- ADR-0020 — Telemetry Storage, Idempotency and Latest State
- stored-runtime-screens.tsx
- process-bridge-runtime.test.ts
- .advance
- validation/process-module.ts
- PlcBridge
- files/[file]/route.ts
- codec.go
- live.test.tsx
- lib/env.ts
- Development Bootstrap Specification
- GatewayEndpointRuntime
- engine.test.ts
- ADR-0019 — Broker Access and Agent Connectivity
- @prisma/adapter-pg
- FakeEventSource
- Linear Workflow
- Product Definition
- StoredScenarios
- TASK-004 — Makefile to Start, Stop and Restart the Local Development Stack
- device-parameters.ts
- clearTagAlarms
- main

## God Nodes (most connected - your core abstractions)
1. `DomainError` - 351 edges
2. `requireActor()` - 102 edges
3. `isDomainError()` - 95 edges
4. `getDb()` - 94 edges
5. `parseInput()` - 77 edges
6. `getDb()` - 60 edges
7. `routes` - 52 edges
8. `createFactory()` - 50 edges
9. `openTestDb()` - 41 edges
10. `DomainError` - 39 edges

## Surprising Connections (you probably didn't know these)
- `StoredPlcRuntime()` --indirect_call--> `getRuntimeDeps()`  [INFERRED]
  app/factories/[factoryId]/plcs/[plcId]/stored-runtime-screens.tsx → lib/services/runtime-deps.ts
- `canConnectFrom()` --indirect_call--> `docker()`  [INFERRED]
  test/integration/tag-runtime.test.ts → apps/web-factory/test/broker-harness.ts
- `EdgeRow()` --calls--> `edgeLabel()`  [EXTRACTED]
  components/canvas/topology-inspector.tsx → lib/topology/flow.ts
- `PlcReport()` --indirect_call--> `signalTypeLabel()`  [INFERRED]
  components/export/plc-report.tsx → lib/catalog/format.ts
- `PinDetails()` --indirect_call--> `signalTypeLabel()`  [INFERRED]
  components/plc/pin-view.tsx → lib/catalog/format.ts

## Import Cycles
- None detected.

## Communities (295 total, 34 thin omitted)

### Community 0 - "module-io-service.ts"
Cohesion: 0.05
Nodes (47): consumed(), MODULE_IO_EXPORT_SCHEMA, MODULE_IO_EXPORT_SCHEMA_VERSION, ModuleBindingView, ModuleIoCandidate, ModuleIoCounts, ModuleIoExportDocument, ModuleIoRegistry (+39 more)

### Community 1 - "devDependencies"
Cohesion: 0.06
Nodes (31): jsdom, devDependencies, dotenv, eslint, eslint-config-next, jsdom, prettier, @tailwindcss/postcss (+23 more)

### Community 2 - "Engine"
Cohesion: 0.14
Nodes (14): Clock, Config, ConfigError, Event, Metrics, StateError, Status, sync.RWMutex (+6 more)

### Community 3 - "Factory/runtime entities"
Cohesion: 0.14
Nodes (14): Catalog3dAsset, DeviceConnection, DeviceInstance, Factory, Factory/runtime entities, FactoryRack / FactoryModule, Gateway, GatewayPlcConnection (+6 more)

### Community 4 - "module-forms.tsx"
Cohesion: 0.04
Nodes (56): ModuleEditorActions, actions, detail, rows, SIGNALS, tank, type, view (+48 more)

### Community 5 - "compilerOptions"
Cohesion: 0.06
Nodes (30): apps, services, compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx (+22 more)

### Community 6 - "telemetry.ts"
Cohesion: 0.06
Nodes (35): TOPIC_SEGMENT, advanceLatest(), batchTimeProblem(), DAY_MS, dayKey(), dayStart(), Latest, QUALITIES (+27 more)

### Community 7 - "process-module-service.ts"
Cohesion: 0.10
Nodes (56): logUnexpected(), moduleDeviceAction(), moduleInterlockAction(), moduleSignalAction(), processBridgeAction(), run(), resolveProfile(), roleAcceptsCategory() (+48 more)

### Community 8 - "Device Simulation"
Cohesion: 0.07
Nodes (26): Approximations, Closed-loop example, Command bridge (TASK-803), Commands and feedback, Device behaviors, Device Simulation, Faults, Faults (+18 more)

### Community 9 - "UX / Design Specification"
Cohesion: 0.06
Nodes (35): 3D, 3D asset status in the catalog (TASK-403), 3D view as built (TASK-402), Activity bar, Capability-driven device editor, Communication as built (TASK-704), Compact, Core screens (+27 more)

### Community 10 - "Architecture"
Cohesion: 0.07
Nodes (29): Architecture, As built (TASK-402, ADR-0012), Authoring as built (TASK-403), Canonical wiring (TASK-307, ADR-0014), Catalog 3D asset pipeline — Phase 04, Control authority, Decision, Device simulation architecture (+21 more)

### Community 11 - "plc-runtime-view-service.ts"
Cohesion: 0.15
Nodes (19): DeploymentView, LocatedVariableView, PlcProgramView, PlcRuntimeView, PlcVersionsView, PROGRAM_VERSION_STATUSES, ProgramVersionStatus, ProgramVersionView (+11 more)

### Community 12 - "OpenPLC Runtime"
Cohesion: 0.09
Nodes (22): As built (TASK-205), Command vs feedback, Container lifecycle, Deployment chain, Failures, I/O and tags, I/O point addresses (TASK-302), Identity (+14 more)

### Community 13 - "docs/README.md"
Cohesion: 0.08
Nodes (19): AI Coding Agent Checklist, Before Done, Before work, During work, Agent workflow, Authority, Graphify Workflow, Repository policy (+11 more)

### Community 14 - "Device Catalog"
Cohesion: 0.08
Nodes (24): 3D assets (TASK-402, ADR-0012), Authoring assets (TASK-403), Control capability and runtime, Controller/runtime capability, Controllers and intermediate/control-interface devices, Device Catalog, Drive relationship metadata, Endpoints and wiring (TASK-307, ADR-0014) (+16 more)

### Community 15 - "Docker Runtime Design"
Cohesion: 0.10
Nodes (20): Callers, Deleting a factory (TASK-206), Device-simulator strategy, Docker Runtime Design, Edit/redeploy, Factory runtime, Fixed container settings, Generated artifacts (+12 more)

### Community 16 - "TASK-104 — UI Shell & Wireframe Screens"
Cohesion: 0.17
Nodes (11): Acceptance, Acceptance criteria, Deviations from the wireframes, Evidence (2026-10-04), Fixture rule, Gate note, Objective, Out of scope (owned by other tasks) (+3 more)

### Community 17 - "External Gateway & Modbus TCP"
Cohesion: 0.07
Nodes (26): Address mapping of the OpenPLC runtime (ADR-0009), Checking from the edge device, Control authority, Data types, Example logical map, External endpoint, External Gateway & Modbus TCP, Feedback path (+18 more)

### Community 18 - "Events and Telemetry"
Cohesion: 0.11
Nodes (18): Alarms, Commands, Event envelope, Event types, Events and Telemetry, Implementation (TASK-204), Implementation (TASK-401, ADR-0011), Internal events (+10 more)

### Community 19 - "PLC Engineering Export / Print"
Cohesion: 0.14
Nodes (13): Connected-device schedule, Human-readable export, Implementation (TASK-304), Machine-readable exports, Not implemented, One document, several outputs, PLC Engineering Export / Print, Requirement (+5 more)

### Community 20 - "telemetry-service.ts"
Cohesion: 0.10
Nodes (30): dynamic, GET(), dynamic, GET(), dynamic, GET(), dynamic, GET() (+22 more)

### Community 21 - "asset-authoring-service.ts"
Cohesion: 0.11
Nodes (39): AssetPlanEntry, AuthoringModel, AuthoringResult, findShareableAsset(), generateCatalogAsset(), generateSchema, getAssetPlanEntry(), importCatalogAsset() (+31 more)

### Community 22 - "scene.test.ts"
Cohesion: 0.09
Nodes (23): toFlowEdges(), GlbInspection, inspectGlb(), invalid(), MAX_GLB_BYTES, record(), UNSUPPORTED_EXTENSIONS, vector() (+15 more)

### Community 23 - "lib/services/live-service.ts"
Cohesion: 0.08
Nodes (31): AlarmKey, EventFilter, eventRepository, deviceInclude, SignalTagRecord, SimulatedDeviceRecord, simulationRepository, TAG_ALARM_PREFIX (+23 more)

### Community 24 - "Implemented"
Cohesion: 0.07
Nodes (29): Authorization boundary (ADR-0007), `catalog 3D asset authoring` (TASK-403), `catalog 3D assets` and the `scene` (TASK-402, ADR-0012), `catalog` (TASK-301), Commands, `device screens` (TASK-308), `edge deployment` (TASK-503, ADR-0017), `events`, `alarms` and the live channel (TASK-401) (+21 more)

### Community 25 - "topology-canvas.tsx"
Cohesion: 0.09
Nodes (36): DevicePalette(), DevicePaletteProps, PALETTE_MIME, PlaceResult, Canvas(), CanvasActions, DeviceNode, DeviceNodeData (+28 more)

### Community 26 - "Z-Factory AI Agent Contract"
Cohesion: 0.29
Nodes (6): Definition of Done, Non-negotiable architecture rules, Programmable-device rules, Read order before changing code, Task execution protocol, Z-Factory AI Agent Contract

### Community 27 - "wiring-editor.tsx"
Cohesion: 0.15
Nodes (18): optionText(), Result, suggest(), endpoint(), ok(), pair(), setup(), wire (+10 more)

### Community 28 - "dev-stack.sh"
Cohesion: 0.15
Nodes (33): compose(), env_value(), fail(), for_parts(), migrate(), port_in_use(), quiet(), say() (+25 more)

### Community 29 - "TASK-003 — Development Bootstrap Specification"
Cohesion: 0.25
Nodes (7): Acceptance, Choices recorded during TASK-101/TASK-104 (2026-10-04), Deliverables, Evidence (2026-10-04), Objective, Planned choices, TASK-003 — Development Bootstrap Specification

### Community 30 - "TASK-204 — Device Simulator Runtime"
Cohesion: 0.20
Nodes (9): Acceptance, Decisions (ADR-0010, accepted), Evidence (2026-10-05), Goal, Invariants, Not in this task, Schema change, Scope (+1 more)

### Community 31 - "TASK-301 — Device Catalog & Provenance"
Cohesion: 0.17
Nodes (11): Acceptance criteria, Decisions made in this task, Evidence (2026-10-05), Industrial control / intermediate device categories, Initial PLC targets, Not in this task, Objective, Peripheral categories (+3 more)

### Community 32 - "TASK-302 — Compact & Modular PLC Configuration"
Cohesion: 0.20
Nodes (9): Acceptance criteria, Acceptance not fully met, Compact path, Decisions made in this task, Evidence (2026-10-05), Modular path, Not in this task, Objective (+1 more)

### Community 33 - "gateway-endpoint/runtime.ts"
Cohesion: 0.11
Nodes (23): ModbusArea, exchange(), MAP, read(), write(), answer(), createModbusServer(), illegalValue() (+15 more)

### Community 34 - "Z-Factory"
Cohesion: 0.29
Nodes (6): AI-assisted development, Core control principle, Development, MVP architecture, Runtime and persistence, Z-Factory

### Community 35 - "ADR-0001 — Single Next.js Application for MVP"
Cohesion: 0.40
Nodes (4): ADR-0001 — Single Next.js Application for MVP, Consequences, Context, Decision

### Community 36 - "dependencies"
Cohesion: 0.06
Nodes (31): dockerode, fflate, dependencies, dockerode, fflate, next, pg, @prisma/adapter-pg (+23 more)

### Community 37 - "TASK-001 — Documentation Baseline"
Cohesion: 0.40
Nodes (4): Acceptance, Completed, Objective, TASK-001 — Documentation Baseline

### Community 38 - "TASK-002 — Linear Project & Task Sync"
Cohesion: 0.33
Nodes (5): Acceptance, Evidence (2026-10-04), Objective, Steps, TASK-002 — Linear Project & Task Sync

### Community 39 - "TASK-101 — Bootstrap Next.js"
Cohesion: 0.29
Nodes (6): Acceptance criteria, Completion (2026-10-04), Instructions for AI agent, Objective, Progress (2026-10-04), TASK-101 — Bootstrap Next.js

### Community 40 - "TASK-102 — Prisma & Domain Foundation"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Deviations from the original `docs/database.md` (now documented there), Evidence (2026-10-04), Not in this task, Objective, Scope, TASK-102 — Prisma & Domain Foundation

### Community 41 - "TASK-202 — OpenPLC Runtime Adapter"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Evidence (2026-10-05), Image research (2026-10-05), Not in this task, Objective, Required behavior, Spike result (2026-10-05), TASK-202 — OpenPLC Runtime Adapter

### Community 42 - "TASK-304 — PLC Engineering Export"
Cohesion: 0.25
Nodes (7): Acceptance, Decisions made in this task, Evidence (2026-10-05), Goal, Not in this task, Scope, TASK-304 — PLC Engineering Export

### Community 43 - "TASK-502 — End-to-End MVP Demo"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Closed (owner's decision, 2026-10-05), Decisions made in this task, Demo chain, Evidence (2026-10-05), Not in this task, Objective, TASK-502 — End-to-End MVP Demo

### Community 44 - "site-service.ts"
Cohesion: 0.06
Nodes (65): dynamic, GET(), dynamic, GET(), dynamic, runtime, isUuid(), requireMembership() (+57 more)

### Community 45 - "device-sim/engine.ts"
Cohesion: 0.08
Nodes (35): Common, createDevice(), Device, faultDefinitions(), GenericLoad, hasLatchingFault(), Load, Motor (+27 more)

### Community 47 - "ADR-0002 — OpenPLC as First PLC Runtime"
Cohesion: 0.50
Nodes (3): ADR-0002 — OpenPLC as First PLC Runtime, Consequences, Decision

### Community 48 - "ADR-0003 — Explicit Compact vs Modular PLC Modeling"
Cohesion: 0.50
Nodes (3): ADR-0003 — Explicit Compact vs Modular PLC Modeling, Consequences, Decision

### Community 49 - "ADR-0004 — Docker Engine API Orchestration"
Cohesion: 0.50
Nodes (3): ADR-0004 — Docker Engine API Orchestration, Consequences, Decision

### Community 50 - "ADR 0005 — Runtime State and Device Simulation"
Cohesion: 0.50
Nodes (3): ADR 0005 — Runtime State and Device Simulation, Consequences, Decision

### Community 51 - "ADR 0006 — Gateway Commands Preserve PLC Control Authority"
Cohesion: 0.50
Nodes (3): ADR 0006 — Gateway Commands Preserve PLC Control Authority, Consequences, Decision

### Community 52 - "TASK-103 — Factory CRUD"
Cohesion: 0.29
Nodes (6): Acceptance criteria, Decision, Evidence (2026-10-04), Known limits, Objective, TASK-103 — Factory CRUD

### Community 53 - "TASK-201 — Docker Engine Integration"
Cohesion: 0.33
Nodes (5): Acceptance criteria, Evidence (2026-10-05), Not in this task, Objective, TASK-201 — Docker Engine Integration

### Community 54 - "TASK-203 — Modbus Mapping & External Ports"
Cohesion: 0.29
Nodes (6): Acceptance criteria, Changed from TASK-202, Evidence (2026-10-05), Not in this task, Objective, TASK-203 — Modbus Mapping & External Ports

### Community 55 - "TASK-303 — React Flow Factory Topology"
Cohesion: 0.29
Nodes (6): Acceptance criteria, Decisions made in this task, Evidence (2026-10-05), Not in this task, Objective, TASK-303 — React Flow Factory Topology

### Community 56 - "TASK-401 — Events & Live Telemetry"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Decisions made in this task, Defects found and fixed while building this, Evidence (2026-10-05), Not in this task, Objective, TASK-401 — Events & Live Telemetry

### Community 57 - "TASK-402 — Three.js Factory View"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Decisions made in this task, Evidence (2026-10-05), Not in this task, Objective, Scope change (2026-10-05, agreed with the owner), TASK-402 — Three.js Factory View

### Community 58 - "TASK-501 — Industrial Edge / Raspberry Pi Connectivity"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Closed (owner's decision, 2026-10-05), Decisions made in this task, Evidence (2026-10-05), Not in this task, Objective, TASK-501 — Industrial Edge / Raspberry Pi Connectivity

### Community 73 - "Batch"
Cohesion: 0.12
Nodes (20): go.etcd.io/bbolt.Bucket, go.etcd.io/bbolt.DB, sync.Mutex, counter(), Spool, key(), Open(), setCounter() (+12 more)

### Community 74 - "lib/domain/errors.ts"
Cohesion: 0.09
Nodes (36): DOMAIN_ERROR_CODES, isWritableModbusArea(), isWritableTagRole(), AREA_PREFIX, assertDataTypeFits(), formatLocatedAddress(), invalid(), LocatedAddress (+28 more)

### Community 75 - "simulation-service.ts"
Cohesion: 0.05
Nodes (64): deviceFaultAction(), field(), logUnexpected(), plural(), simulationAction(), Actor, DEVICE_FAULTS, DeviceSnapshot (+56 more)

### Community 76 - "device-tree.tsx"
Cohesion: 0.13
Nodes (15): devicesText(), DeviceTree(), DeviceTreeProps, Node, controllerKind(), buildDeviceTree(), byName(), countDescendants() (+7 more)

### Community 77 - "stored-device.tsx"
Cohesion: 0.07
Nodes (33): dynamic, metadata, Page(), PageProps, dynamic, metadata, Page(), PageProps (+25 more)

### Community 78 - "ADR 0007 — Single-Owner Mode Behind One Authorization Boundary"
Cohesion: 0.40
Nodes (4): ADR 0007 — Single-Owner Mode Behind One Authorization Boundary, Consequences, Context, Decision

### Community 79 - "event-service.ts"
Cohesion: 0.05
Nodes (38): FactoryChanges, factoryRepository, NewFactory, withSummary, eventTypesOf(), NewRuntimeEvent, LiveMessage, EventBus (+30 more)

### Community 80 - "testing.T"
Cohesion: 0.12
Nodes (40): os/exec.Cmd, testing.T, Model, Event, nan(), run(), TestPumpHouseRampsFlowAndPressureFromTheCommand(), TestPumpHouseRefusesParametersItDoesNotHaveOrCannotUse() (+32 more)

### Community 81 - "topology-service.ts"
Cohesion: 0.07
Nodes (36): plcInclude, PlcRecord, plcRepository, ADR-0013, deviceInclude, TopologyDeviceRecord, topologyRepository, isPlc() (+28 more)

### Community 82 - "device-detail-service.ts"
Cohesion: 0.12
Nodes (29): DEVICE_SECTION_LABELS, DEVICE_SECTIONS, DeviceCapability, deviceSections(), hasCapability(), isProgrammableController(), ModelCapabilities, programSupport (+21 more)

### Community 83 - "[architecture]/page.tsx"
Cohesion: 0.12
Nodes (25): dynamic, isArchitecture(), metadata, NewDevicePage(), NewDevicePageProps, ADR-0003, createPlcAction(), deletePlcAction() (+17 more)

### Community 84 - "adapter.ts"
Cohesion: 0.09
Nodes (30): deployProgram(), DeployResult, healthState(), poll(), restartOpenPlc(), sleep(), ADR-0009, API_CONTAINER_PORT (+22 more)

### Community 85 - "Process Modules"
Cohesion: 0.11
Nodes (18): Device assignment, Devices in roles, Fidelity, Implementation (TASK-601, TASK-605), Interlocks, Intermediate devices, Module I/O contract, Module instances (+10 more)

### Community 86 - "scene-view.tsx"
Cohesion: 0.06
Nodes (37): Action, AREA_LABEL, Connection(), endpointPill(), GatewayActions, GatewaysScreen(), actions, connection() (+29 more)

### Community 87 - "FactorySimulation"
Cohesion: 0.21
Nodes (3): isLoadType(), FactorySimulation, invariant()

### Community 88 - "strucpp-worker.mjs"
Cohesion: 0.47
Nodes (5): main(), ADR-0009, readStdin(), STANDARD_LIBRARIES, toDiagnostic()

### Community 92 - "openplc-adapter.test.ts"
Cohesion: 0.20
Nodes (7): allocateHostPorts(), createOpenPlcContainer(), OpenPlcTarget, deviceId, factoryId, policy, runId

### Community 93 - "plc-config-service.ts"
Cohesion: 0.08
Nodes (47): channelOrder, ConfigPlcRecord, plcConfigRepository, plcInclude, findSignal(), BANK_LABELS, channelOf(), ConfigPlc (+39 more)

### Community 95 - "TASK-605 — Module PLC I/O Registry & Allocation"
Cohesion: 0.17
Nodes (11): Acceptance, Direction convention, Evidence, Example, Goal, Implementation (2026-10-06), Invariants, Scope (+3 more)

### Community 96 - "ADR 0008 — Post-MVP Go Process Simulation Service"
Cohesion: 0.29
Nodes (6): ADR 0008 — Post-MVP Go Process Simulation Service, Compatibility rule, Consequences, Context, Decision, Process-module rule

### Community 97 - "TASK-603 — Simulator / Modbus Closed-Loop Bridge"
Cohesion: 0.20
Nodes (9): Acceptance, Canonical flow, Evidence, Goal, Implementation (2026-10-06), Invariants, Scope, TASK-603 — Simulator / Modbus Closed-Loop Bridge (+1 more)

### Community 98 - "TASK-702 — Modbus TCP Client/Server Mapping"
Cohesion: 0.20
Nodes (9): Acceptance, Evidence, Examples, Goal, Implementation (2026-10-06), Invariants, Scope, TASK-702 — Modbus TCP Client/Server Mapping (+1 more)

### Community 99 - "TASK-703 — PLC-to-PLC Runtime Adapter & Docker Networking"
Cohesion: 0.20
Nodes (9): Acceptance, Evidence, Goal, Implementation (2026-10-06), Invariants, Runtime flow, Scope, TASK-703 — PLC-to-PLC Runtime Adapter & Docker Networking (+1 more)

### Community 100 - "connection-service.ts"
Cohesion: 0.10
Nodes (26): connectionRepository, NewConnection, signalFits(), CONTROLLER_CATEGORY_CODES, DRIVE_TYPE_BY_CATEGORY, IoPointSource, connectDevicesInTransaction(), Endpoint (+18 more)

### Community 101 - "Phase 06 — Process Module Framework & Go Simulation Service"
Cohesion: 0.33
Nodes (5): Exit criteria, Gate, Key architecture rule, Phase 06 — Process Module Framework & Go Simulation Service, Purpose

### Community 102 - "TASK-601 — Process Module Domain & Persistence"
Cohesion: 0.25
Nodes (7): Acceptance, Decisions made in this task, Evidence (2026-10-05), Goal, Invariants, Scope, TASK-601 — Process Module Domain & Persistence

### Community 103 - "TASK-602 — Go Simulation Service Foundation"
Cohesion: 0.25
Nodes (7): Acceptance, Decisions made in this task, Evidence (2026-10-06), Goal, Invariants, Scope, TASK-602 — Go Simulation Service Foundation

### Community 104 - "TASK-604 — Process Module Designer & Validation"
Cohesion: 0.22
Nodes (8): Acceptance, Evidence, Goal, Implementation (2026-10-06), Invariants, Scope, TASK-604 — Process Module Designer & Validation, Validation (2026-10-06)

### Community 105 - "Phase 07 — PLC-to-PLC Communication"
Cohesion: 0.33
Nodes (5): Canonical logic, Exit criteria, Gate, Phase 07 — PLC-to-PLC Communication, Purpose

### Community 106 - "TASK-701 — PLC Relationship & Communication Domain"
Cohesion: 0.22
Nodes (8): Acceptance, Evidence, Implementation (2026-10-06), Invariants, Scope, TASK-701 — PLC Relationship & Communication Domain, User story, Validation (2026-10-06)

### Community 107 - "TASK-704 — PLC-to-PLC UI, Validation & E2E Tests"
Cohesion: 0.22
Nodes (8): Acceptance, Evidence, Goal, Implementation (2026-10-06), Required E2E scenarios, Scope, TASK-704 — PLC-to-PLC UI, Validation & E2E Tests, Validation (2026-10-06)

### Community 108 - "ADR 0009 — OpenPLC Runtime v4 Image and the STruC++ Compile Step"
Cohesion: 0.40
Nodes (4): ADR 0009 — OpenPLC Runtime v4 Image and the STruC++ Compile Step, Consequences, Context, Decision

### Community 109 - "stored-screens.tsx"
Cohesion: 0.03
Nodes (71): dynamic, EventsPage(), EventsPageProps, metadata, ConnectionsPage(), ConnectionsPageProps, dynamic, metadata (+63 more)

### Community 110 - "domain/scenario.ts"
Cohesion: 0.14
Nodes (18): format(), longestRunS(), OPERATOR, satisfies(), Scenario, SCENARIO_COMPARISONS, SCENARIO_LIMITS, ScenarioComparison (+10 more)

### Community 111 - "Deployment"
Cohesion: 0.12
Nodes (14): sync/atomic.Bool, sync/atomic.Int32, Deployment, Runner, Status, Supervisor, New(), deployment() (+6 more)

### Community 112 - "authoring.test.ts"
Cohesion: 0.11
Nodes (20): catalog, catalogModels, categoryName, generation, assertGenericPrompt(), AssetPrompt, BRAND_WORDS, buildAssetPrompt() (+12 more)

### Community 113 - "domain/plc-communication.ts"
Cohesion: 0.07
Nodes (36): checkLinkMapping(), checkOpenPlcLinkMapping(), checkPlcLink(), LinkEndpointPlc, LinkTag, mappingRefusal(), OPENPLC_LINK_TYPES, PLC_LINK_CLIENTS (+28 more)

### Community 114 - "Server"
Cohesion: 0.15
Nodes (18): problem, Server, statusRecorder, net/http.Handler, net/http.HandlerFunc, net/http.Request, net/http.ResponseWriter, strings.Builder (+10 more)

### Community 115 - "scripts"
Cohesion: 0.11
Nodes (18): scripts, assets, build, db:deploy, db:down, db:generate, db:migrate, db:seed (+10 more)

### Community 116 - "process-bridge-service.ts"
Cohesion: 0.12
Nodes (28): overrideAction(), processBridgeRepository, ProcessTagRecord, recordEvents(), startProcess(), clearProcessOverride(), DEFAULT_PROCESS_TICK_MS, getProcessBridgeState() (+20 more)

### Community 117 - "process-bridge/runtime.ts"
Cohesion: 0.05
Nodes (43): fromModelValue(), toModelValue(), PROCESS_SIM_CONTRACT_VERSION, PROCESS_SIM_MODELS, ProcessSimClock, ProcessSimConfig, ProcessSimEvent, ProcessSimHealth (+35 more)

### Community 118 - "siemens.ts"
Cohesion: 0.17
Nodes (12): PLC_CAPABILITIES, CatalogInput, controllerSpecs, ioSpecs, rockwell, hardwareGuide, schneider, cpu1511Manual (+4 more)

### Community 119 - "plc-report.tsx"
Cohesion: 0.10
Nodes (22): dash(), Diagram(), PlcReport(), PlcReportProps, relationship(), compact, utc(), DIAGRAM_NODE (+14 more)

### Community 120 - "TASK-206 — Remove a Factory's Docker Network and PLC Containers When It Is Deleted"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Evidence (2026-10-07), Finding (2026-10-07), Implementation, Limitations, Objective, TASK-206 — Remove a Factory's Docker Network and PLC Containers When It Is Deleted

### Community 121 - "TASK-503 — Z-Factory Thin Client Agent: File-Driven Dynamic PLC Connectivity, Concurrency & MQTT Cloud Uplink"
Cohesion: 0.08
Nodes (24): Acceptance criteria, As built (503a), As built (503b), As built (503c), Cloud command path, Core flow, Coverage of the test list, Delivery (approved 2026-10-07) (+16 more)

### Community 122 - "package.json"
Cohesion: 0.33
Nodes (5): engines, node, name, private, version

### Community 123 - "ADR 0010 — In-Process Device Simulator and PLC Bridge"
Cohesion: 0.40
Nodes (4): ADR 0010 — In-Process Device Simulator and PLC Bridge, Consequences, Context, Decision

### Community 124 - "catalog-service.ts"
Cohesion: 0.11
Nodes (30): buildTree(), CatalogPage(), defaultModelId(), vendorsFirst(), CatalogModelRecord, catalogRepository, modelInclude, CatalogOverview (+22 more)

### Community 125 - "catalog/schema.ts"
Cohesion: 0.07
Nodes (35): GENERIC_CATEGORIES, GenericCategory, CatalogChannelGroup, CatalogModel, CatalogModule, catalogSchema, channelGroupSchema, electricalSchema (+27 more)

### Community 126 - "factory-canvas.tsx"
Cohesion: 0.06
Nodes (37): DevicePlaceholder(), Vec3, AssetBoundary, CameraView, CatalogModel(), Conductors(), Connection(), DASH (+29 more)

### Community 127 - "mqtt/runtime.ts"
Cohesion: 0.04
Nodes (46): AgentHeartbeat, agentHeartbeatSchema, AgentStatusMessage, agentStatusSchema, AgentTopic, agentTopicRoot(), counter, identity (+38 more)

### Community 128 - "plc-communication-service.ts"
Cohesion: 0.12
Nodes (34): linkInclude, mappingInclude, plcCommunicationRepository, PlcLinkData, PlcLinkMappingRecord, PlcLinkRecord, linkEndRefusal(), toPlcLinkSnapshot() (+26 more)

### Community 129 - "process-modules/schema.ts"
Cohesion: 0.06
Nodes (40): withDomainErrors(), InterlockData, moduleInclude, ModuleRecord, processModuleRepository, MODULE_CONFIG_FIELD_TYPES, MODULE_SIGNAL_DIRECTIONS, ModuleTypeDefinition (+32 more)

### Community 130 - "plc-communication.tsx"
Cohesion: 0.11
Nodes (21): Action, CommunicationActions, Action, LinkSettings(), MappingForm(), NewLinkForm(), tagLabel(), TagSelect() (+13 more)

### Community 131 - "plc-runtime-service.ts"
Cohesion: 0.18
Nodes (34): field(), logFailure(), pauseLive(), plural(), programAction(), programVersionAction(), runtimeAction(), syncLive() (+26 more)

### Community 132 - "getDb"
Cohesion: 0.14
Nodes (28): CanvasResult, connectWireAction(), CONSTRAINT_MESSAGE, disconnectWireAction(), linkDevicesAction(), loadPairWiringAction(), moveDevicesAction(), placeDeviceAction() (+20 more)

### Community 133 - "getDb"
Cohesion: 0.07
Nodes (58): dynamic, GET(), GET(), dynamic, GET(), signInAction(), dynamic, LoginPage() (+50 more)

### Community 134 - "Server"
Cohesion: 0.15
Nodes (4): net.Conn, Server, StartAt(), wordsText()

### Community 135 - "wiring-service.ts"
Cohesion: 0.07
Nodes (57): pointInclude, WIRE_ENDPOINTS, wireInclude, WireRecord, WiringDeviceRecord, WiringPointRecord, wiringRepository, TerminalKind (+49 more)

### Community 136 - "SignalState"
Cohesion: 0.20
Nodes (12): Mode, override, OverrideRequest, Profile, ProfileStep, SignalState, checkProfile(), Engine (+4 more)

### Community 137 - "[agentId]/page.tsx"
Cohesion: 0.08
Nodes (66): AgentPage(), dynamic, metadata, AlarmsPage(), dynamic, metadata, RANGES, dynamic (+58 more)

### Community 139 - "routes.ts"
Cohesion: 0.04
Nodes (89): ASSET_MARK, CatalogPageProps, dynamic, metadata, FactoriesErrorProps, ALARM_STATE, FAMILY_LABEL, Filter (+81 more)

### Community 140 - "gateway-service.ts"
Cohesion: 0.09
Nodes (48): DEMO_DEVICES, DEMO_FACTORY_NAME, DEMO_MAX_HZ, DEMO_MODELS, DEMO_OPERATOR_TAGS, DEMO_POSITIONS, DEMO_PROFILES, DEMO_TRIP_BAR (+40 more)

### Community 141 - "containers.ts"
Cohesion: 0.08
Nodes (57): assertManagedNetwork(), createRuntimeContainer(), inspectManaged(), inspectRuntimeContainer(), removeRuntimeContainer(), restartRuntimeContainer(), RuntimeContainerStatus, startRuntimeContainer() (+49 more)

### Community 142 - "Testing Strategy"
Cohesion: 0.15
Nodes (12): As automated (TASK-502), Definition of Done, End-to-end reference scenario, Layers, Mandatory high-risk tests, PLC-to-PLC communication (Phase 07), Process simulation (Phase 06+), Program authority (TASK-205, ADR-0015) (+4 more)

### Community 143 - "Programmable Devices — End-to-End Model"
Cohesion: 0.09
Nodes (21): Acceptance rules, Capabilities are catalog data, Capability model, Implementation (TASK-308), Not done, Parameters and configuration versions, PLC / programmable RTU, Program lifecycle (+13 more)

### Community 144 - "MVP 2 scope"
Cohesion: 0.12
Nodes (15): 1. Production edge deployment, 2. Dynamic multi-PLC connectivity, 3. Web Factory cloud application, 4. MQTT cloud integration, 5. Offline resilience, 6. Physical edge validation, 7. Security and observability, Architecture boundary (+7 more)

### Community 146 - "events.ts"
Cohesion: 0.19
Nodes (14): EventLogFilter, LEVEL, LiveEventLog(), LiveEventLogProps, matches(), newestFirst(), EVENT_DETAIL_KEYS, EVENT_FAMILIES (+6 more)

### Community 147 - "TASK-305 — Stored PLC Program, Versions, Runtime & Simulator Screens"
Cohesion: 0.18
Nodes (10): Acceptance, Decisions made in this task, Defects found and fixed while wiring the screens, Evidence (2026-10-05), Not in this task, Objective, Out of scope, Prerequisites (+2 more)

### Community 149 - "MVP Demo Runbook — Pump Station"
Cohesion: 0.14
Nodes (13): 1. Create the factory, 2. Start the factory, 3. Get the edge client its register map, 4. Run the pump from the gateway, 5. Interlock: high pressure, 6. Fault: drive overcurrent, 7. Engineering export, 8. Stop (+5 more)

### Community 150 - "TASK-207 — Check a Factory's Subnet Against Existing Docker Networks"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Evidence (2026-10-07), Finding (2026-10-07), Found while verifying (not in this task's scope), Implementation, Limitations, TASK-207 — Check a Factory's Subnet Against Existing Docker Networks

### Community 151 - "PlcLinkMonitorRuntime"
Cohesion: 0.16
Nodes (7): globalRuntime, LinkChange, LinkCheck, LinkHealth, LinkQuality, PlcLinkMonitorRuntime, Watched

### Community 152 - "edge-client.mjs"
Cohesion: 0.27
Nodes (12): EXCEPTIONS, find(), isBit(), map, [mapPath, command, ...rest], read(), READ_FUNCTION, readAll() (+4 more)

### Community 153 - "lib/db/client.ts"
Cohesion: 0.07
Nodes (49): createDemoFactoryAction(), createFactoryAction(), deleteFactoryAction(), logUnexpected(), updateFactoryAction(), actor, dockerStatus, plcConfig (+41 more)

### Community 154 - "DeviceSimulatorRuntime"
Cohesion: 0.14
Nodes (7): RuntimeEventEnvelope, SimEvent, DeviceSimulatorRuntime, bindings, devices, FakePlc, setup()

### Community 155 - "normalize.ts"
Cohesion: 0.13
Nodes (26): placed(), apply(), Extent, IDENTITY, index(), invalid(), Json, Mat4 (+18 more)

### Community 157 - "factory-service.ts"
Cohesion: 0.05
Nodes (80): loadCatalog(), mergeCatalogs(), day(), expandChannels(), ingestCatalog(), ingestModel(), ingestModule(), IngestResult (+72 more)

### Community 158 - "tag-monitor/monitor.ts"
Cohesion: 0.08
Nodes (21): feedbackQuality(), FeedbackWriter, LiveTagReading, TagQuality, DEFAULT_POLL_MS, globalRuntime, isBitArea(), MonitorClock (+13 more)

### Community 159 - "Agent"
Cohesion: 0.14
Nodes (15): Settings, context.CancelFunc, net/http.Server, net.Listener, sync/atomic.Uint64, sync.Once, Agent, Start() (+7 more)

### Community 160 - "TASK-403 — Meshy MCP Catalog 3D Asset Generation"
Cohesion: 0.17
Nodes (11): Acceptance criteria, Already in place (TASK-402, ADR-0012), Asset contract, Closed (owner's decision, 2026-10-05), Decisions made in this task, Evidence (2026-10-05), Flow, Objective (+3 more)

### Community 161 - "Catalog entities"
Cohesion: 0.17
Nodes (12): BuiltInIoChannel, Catalog entities, CommunicationPort, DeviceCategory, DeviceFamily, DeviceFaultDefinition, DeviceIoDefinition, DeviceModel (+4 more)

### Community 162 - "compilerOptions"
Cohesion: 0.07
Nodes (28): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, lib, module (+20 more)

### Community 163 - "telemetry-e2e.test.ts"
Cohesion: 0.13
Nodes (34): Actor, createPrismaClient(), commandEnvelope(), audit(), applyAck(), issueCommand(), createAgent(), createSite() (+26 more)

### Community 164 - "TASK-404 — Live 3D Runtime-State Visualization"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Connection rules, Decisions made in this task, Evidence (2026-10-05), Not in this task, Objective, State rules, TASK-404 — Live 3D Runtime-State Visualization

### Community 165 - "ADR 0011 — Live Channel: SSE, In-Process Tag Monitor and Replay by Event Order"
Cohesion: 0.40
Nodes (4): ADR 0011 — Live Channel: SSE, In-Process Tag Monitor and Replay by Event Order, Consequences, Context, Decision

### Community 167 - "requireActor"
Cohesion: 0.07
Nodes (65): saveParametersAction(), addGatewayAction(), connectGatewayAction(), field(), gatewayConnectionAction(), logUnexpected(), mapGatewayTagAction(), run() (+57 more)

### Community 168 - "commands.ts"
Cohesion: 0.13
Nodes (16): ACK_SCHEMA, ACK_STATUSES, afterAck(), checkValue(), COMMAND_SCHEMA, CommandMapping, CommandRefusal, CommandStatusName (+8 more)

### Community 169 - "New"
Cohesion: 0.12
Nodes (30): Clock, log/slog.Logger, net/http/httptest.Server, envOr(), main(), New(), call(), newServer() (+22 more)

### Community 170 - "TASK-208 — "Stop Factory" Must Leave a Factory Stopped After a Failed Start"
Cohesion: 0.50
Nodes (3): Acceptance criteria, Finding (2026-10-07), TASK-208 — "Stop Factory" Must Leave a Factory Stopped After a Failed Start

### Community 171 - "dependencies"
Cohesion: 0.10
Nodes (21): dependencies, dotenv, mqtt, next, next-auth, pg, @prisma/client, react (+13 more)

### Community 172 - "domain/process-module.ts"
Cohesion: 0.14
Nodes (26): buildModuleIo(), checkProcessMappings(), appliesToProfile(), checkConfigValue(), checkInterlock(), checkModuleType(), countSignals(), duplicates() (+18 more)

### Community 173 - "devDependencies"
Cohesion: 0.10
Nodes (21): devDependencies, eslint, eslint-config-next, prisma, tsx, @types/node, @types/pg, @types/react (+13 more)

### Community 174 - "Edge Deployment — Thin Client Agent in Production"
Cohesion: 0.14
Nodes (13): Configure and onboard, Container instead of systemd, Deploy PLCs, Edge Deployment — Thin Client Agent in Production, Install (systemd), Observe, Physical validation checklist (open), Sizing (+5 more)

### Community 175 - "Process modules"
Cohesion: 0.25
Nodes (8): ModuleDevice, ModuleInterlock, ModulePlcIoMapping (TASK-605), ModuleRoleDefinition, ModuleSignalDefinition, Process modules, ProcessModuleInstance, ProcessModuleType

### Community 176 - "time.Time"
Cohesion: 0.15
Nodes (20): cacheEntry, github.com/eclipse/paho.mqtt.golang.Message, time.Time, Check(), deref(), Ack, Cache, Envelope (+12 more)

### Community 177 - "parseInput"
Cohesion: 0.10
Nodes (32): modelAssetKey(), Db, assetRepository, authoringSelect, normalizeDegrees(), activeIdOf(), AssetDeps, AssetRecord (+24 more)

### Community 178 - "ADR 0012 — Catalog 3D Assets: Record in PostgreSQL, File in a Server Directory"
Cohesion: 0.33
Nodes (5): ADR 0012 — Catalog 3D Assets: Record in PostgreSQL, File in a Server Directory, Consequences, Context, Decision, Follow-up (TASK-403, 2026-10-05)

### Community 179 - "model.go"
Cohesion: 0.19
Nodes (10): Event, Model, New(), Register(), Types(), init(), TestModelsAreRegisteredWithTheirContract(), Factory (+2 more)

### Community 180 - "TASK-205 — Program-Authoritative I/O Semantics & Physical Target Boundary"
Cohesion: 0.15
Nodes (12): Acceptance criteria, Evidence, Implementation (2026-10-06), Objective, Physical PLC, Remote command, Required control paths, Scope (+4 more)

### Community 181 - "modbus/client.ts"
Cohesion: 0.17
Nodes (25): assertRange(), assertResponse(), exchange(), isBitArea(), ModbusEndpoint, READ_FUNCTION, readModbus(), writeModbus() (+17 more)

### Community 182 - "live.ts"
Cohesion: 0.12
Nodes (25): formatAge(), formatValue(), LiveTagTable(), LiveTagTableProps, QUALITY_SHORT, STATUS_TONE, ADR-0015, WriteAction (+17 more)

### Community 183 - "config.go"
Cohesion: 0.10
Nodes (30): Body, Document, Error, Module, PLC, Site, encoding/json.RawMessage, IsBool() (+22 more)

### Community 184 - "context.Context"
Cohesion: 0.10
Nodes (18): context.Context, time.Duration, Client, ExceptionError, Write, IsException(), New(), span() (+10 more)

### Community 185 - "bridge.ts"
Cohesion: 0.13
Nodes (20): SignalDirection, arrange(), ByteOrder, encodeValue(), Encoding, engineeringRange(), invalidValue(), RANGE (+12 more)

### Community 186 - "TASK-209 — Reconcile Stored Runtime State With Docker After a Host Restart"
Cohesion: 0.50
Nodes (3): Acceptance criteria, Finding (2026-10-07), TASK-209 — Reconcile Stored Runtime State With Docker After a Host Restart

### Community 187 - "OpenPlcClient"
Cohesion: 0.29
Nodes (3): openPlcHealth, startOpenPlc(), OpenPlcClient

### Community 188 - "Security Model"
Cohesion: 0.20
Nodes (9): Gateway endpoints (TASK-501, ADR-0013), Go process simulation service (Phase 06+), Industrial-control warning, Mandatory controls, OpenPLC runtime access (ADR-0009), PLC-to-PLC links (TASK-703, ADR-0016), Production note, Security Model (+1 more)

### Community 189 - "catalog/catalog.test.ts"
Cohesion: 0.08
Nodes (29): catalog, expectRejected(), firstModel(), MANUFACTURER_HOSTS, Model, withModel(), analog(), contact() (+21 more)

### Community 190 - "telemetry-chart.tsx"
Cohesion: 0.38
Nodes (6): Bucket, format(), PAD, RANGES, TelemetryChart(), time()

### Community 191 - "domain/simulation.ts"
Cohesion: 0.10
Nodes (17): FAULT_RESET, FaultDefinition, FAULTED, GENERIC_LOAD, LOAD_TYPES, LoadType, RUNNING, Severity (+9 more)

### Community 192 - "ADR 0013 — External Gateways Connect to a Filtering Modbus Endpoint"
Cohesion: 0.40
Nodes (4): ADR 0013 — External Gateways Connect to a Filtering Modbus Endpoint, Consequences, Context, Decision

### Community 193 - "tag-authority.ts"
Cohesion: 0.31
Nodes (7): DEVICE_SIGNALS, deviceSignalDirection(), AuthorityTag, region(), TAG_AUTHORITIES, tagAuthority, ADR-0015

### Community 194 - "Store"
Cohesion: 0.13
Nodes (18): activeFile, Problem, Rejection, io/fs.DirEntry, os.FileInfo, Report, Store, Open() (+10 more)

### Community 195 - "TASK-307 — Pin-to-Pin Wiring Editor & Validation"
Cohesion: 0.20
Nodes (9): 2D UX, Acceptance criteria, Canonical mapping, Decisions made in this task, Evidence (2026-10-06), Objective, Rules, TASK-307 — Pin-to-Pin Wiring Editor & Validation (+1 more)

### Community 196 - "Process Simulation Service"
Cohesion: 0.17
Nodes (11): Boundaries, Bridge (TASK-603), Configuration contract (version 1), Determinism, Lifecycle, Models, Observability, Overrides (Phase 08, TASK-801) (+3 more)

### Community 197 - "TASK-306 — Factory Overview Device Hierarchy"
Cohesion: 0.22
Nodes (8): Acceptance, Decisions made in this task, Evidence (2026-10-06), Objective, Out of scope, Prerequisites, Scope, TASK-306 — Factory Overview Device Hierarchy

### Community 198 - "TASK-405 — 3D Physical Conductor Rendering"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Decisions made in this task, Evidence (2026-10-06), Objective, Rendering rules, Runtime state, TASK-405 — 3D Physical Conductor Rendering, User stories

### Community 199 - "plc-config-view.ts"
Cohesion: 0.13
Nodes (18): describe(), ModuleInstallForm(), ModuleInstallFormProps, PinDetails(), pinState(), pinTitle(), PinView(), PinViewProps (+10 more)

### Community 200 - "TASK-309 — Retire Design Fixtures"
Cohesion: 0.25
Nodes (7): Acceptance, Decisions made in this task, Evidence (2026-10-06), Objective, Prerequisites, Scope, TASK-309 — Retire Design Fixtures

### Community 201 - "Phase 08 — Simulation Control, Overrides & Closed-Loop Testing"
Cohesion: 0.22
Nodes (8): End-to-end model, Exit criteria, Gate, Phase 08 — Simulation Control, Overrides & Closed-Loop Testing, Purpose, Rules, Simulation modes, Tasks

### Community 202 - "TASK-308 — Capability-Driven Programmable Device UI & Runtime"
Cohesion: 0.29
Nodes (6): Acceptance criteria, Decisions made in this task, Evidence (2026-10-06), Scope, TASK-308 — Capability-Driven Programmable Device UI & Runtime, User stories

### Community 203 - "Uplink"
Cohesion: 0.19
Nodes (10): github.com/eclipse/paho.mqtt.golang.Client, github.com/eclipse/paho.mqtt.golang.ClientOptions, sync.WaitGroup, Store, Settings, Uplink, redact(), Start() (+2 more)

### Community 204 - "ADR-0015 — PLC Scan-Cycle Authority and Physical I/O Boundary"
Cohesion: 0.25
Nodes (7): ADR-0015 — PLC Scan-Cycle Authority and Physical I/O Boundary, Consequences, Context, Decision, External command path, Physical PLC target, Simulation

### Community 205 - "ADR 0014 — One Wire Between Two Exact Endpoints Is the Only Source of Wiring"
Cohesion: 0.40
Nodes (4): ADR 0014 — One Wire Between Two Exact Endpoints Is the Only Source of Wiring, Consequences, Context, Decision

### Community 206 - "runtime-state.ts"
Cohesion: 0.10
Nodes (24): SceneView(), refresh, SCENE, webglAvailable(), GatewayAccess, GatewayEndpointView, GatewayMapDocument, GatewayRegisterView (+16 more)

### Community 207 - "edge-deployment-service.ts"
Cohesion: 0.14
Nodes (18): Context, dynamic, GET(), number(), tagRepository, EDGE_DEPLOYMENT_SCHEMA, EDGE_DEPLOYMENT_SCHEMA_VERSION, EDGE_LIMITS (+10 more)

### Community 208 - "topology.ts"
Cohesion: 0.15
Nodes (15): CONTROLLER_CATEGORY_CODES, isSensorLike(), LINK_KINDS, LinkKind, LinkOption, linkOptions(), protocolName(), shared() (+7 more)

### Community 209 - "Simulation/state/history"
Cohesion: 0.29
Nodes (7): AlarmEvent, DeviceCommand, DeviceRuntimeSnapshot, RuntimeEvent, Simulation/state/history, SimulationProfile, TelemetrySample

### Community 212 - "TASK-801 — Simulation Override Runtime Contract & Go API"
Cohesion: 0.18
Nodes (10): Acceptance criteria, Evidence, Goal, Implementation (2026-10-06), Proposed contract, Runtime behavior, TASK-801 — Simulation Override Runtime Contract & Go API, User stories (+2 more)

### Community 213 - "TASK-804 — Closed-Loop Test Scenarios, Events & E2E Validation"
Cohesion: 0.18
Nodes (10): Acceptance criteria, As built, Event/audit requirements, Evidence, Goal, High-temperature alarm, Limits, Scenario examples (+2 more)

### Community 214 - "catalog-view.tsx"
Cohesion: 0.11
Nodes (26): ASSET_TONE, AssetPill(), CatalogModelView(), CatalogModelViewProps, channelText(), connectionText(), fileSize(), fitText() (+18 more)

### Community 215 - "TASK-802 — Simulation Override UI & Operator Controls"
Cohesion: 0.22
Nodes (8): Acceptance criteria, Evidence, Goal, Implementation (2026-10-06), Rules, TASK-802 — Simulation Override UI & Operator Controls, UX, Validation (2026-10-06)

### Community 216 - "TASK-803 — PLC Output → Simulator Command Bridge"
Cohesion: 0.22
Nodes (8): Acceptance criteria, As built, Evidence, Goal, Limits, Required flow, Rules, TASK-803 — PLC Output → Simulator Command Bridge

### Community 217 - "TASK-901 — Web Factory TypeScript Cloud Foundation & Identity Model"
Cohesion: 0.22
Nodes (8): Acceptance criteria, As built, Decisions (owner, 2026-10-07), Evidence, Notes, Objective, Scope, TASK-901 — Web Factory TypeScript Cloud Foundation & Identity Model

### Community 218 - "TASK-902 — MQTT Broker Integration, Agent Onboarding & Connectivity"
Cohesion: 0.20
Nodes (9): Acceptance criteria, Acceptance criteria — evidence, As built, Decisions (owner, 2026-10-07), Evidence, Notes, Objective, Scope (+1 more)

### Community 219 - "TASK-903 — Telemetry Ingestion, Cloud Persistence & Latest-State Projection"
Cohesion: 0.20
Nodes (9): Acceptance criteria, Acceptance criteria — evidence, As built, Decisions (owner, 2026-10-07), Evidence, Notes, Objective, Scope (+1 more)

### Community 220 - "TASK-904 — Web Factory Live Monitoring, Dashboards, Events & Alarms"
Cohesion: 0.20
Nodes (9): Acceptance criteria, Acceptance criteria — evidence, As built, Decisions (owner, 2026-10-07), Evidence, Notes, Objective, Scope (+1 more)

### Community 221 - "TASK-905 — Remote Command/Setpoint Lifecycle, Authorization & Audit"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Acceptance criteria — evidence, As built, Evidence, Objective, Scope, TASK-905 — Remote Command/Setpoint Lifecycle, Authorization & Audit

### Community 222 - "TASK-906 — Production Edge Deployment, Resilience, Security & Physical E2E"
Cohesion: 0.20
Nodes (9): Acceptance criteria, Acceptance criteria — evidence, As built, Decisions (owner, 2026-10-07), Evidence, Objective, Open (owner), Scope (+1 more)

### Community 223 - "Database Design"
Cohesion: 0.33
Nodes (5): Catalog provenance, Core design rules, Database Design, Database-enforced invariants, Implementation (TASK-102)

### Community 224 - "user-service.ts"
Cohesion: 0.09
Nodes (32): metadata, UsersPage(), when(), HomePage(), derive(), hashPassword(), passwordProblem(), verifyPassword() (+24 more)

### Community 225 - "Tank"
Cohesion: 0.22
Nodes (3): resolve(), init(), Tank

### Community 226 - "install.sh"
Cohesion: 0.62
Nodes (6): place_binary(), say(), install.sh script, system(), usage(), verify()

### Community 227 - "PLC-to-PLC communication (Phase 07)"
Cohesion: 0.50
Nodes (4): ConfigurationVersion, PLC-to-PLC communication (Phase 07), PlcCommunicationConnection (TASK-701), PlcCommunicationMapping (TASK-702)

### Community 228 - "connectivity.ts"
Cohesion: 0.09
Nodes (31): loadAlarmFacts(), sweepAlarms(), SweepOptions, SweepResult, ADR-0021, AlarmCondition, AlarmFacts, alarmKey() (+23 more)

### Community 229 - "factory-crud.test.ts"
Cohesion: 0.07
Nodes (26): constraintName(), ConstraintRule, CONSTRAINTS, DriverCause, isPrismaRequestError(), PrismaRequestError, toDomainError(), deviceRepository (+18 more)

### Community 230 - "meshy.ts"
Cohesion: 0.21
Nodes (12): AssetProvider, createMeshyProvider(), call(), estimateCredits(), failure(), Fetch, GenerationRequest, JOB_STATUSES (+4 more)

### Community 231 - "scripts"
Cohesion: 0.17
Nodes (12): scripts, build, create-admin, db:deploy, db:generate, db:migrate, dev, lint (+4 more)

### Community 232 - "TASK-907 — Recheck Command Expiry Immediately Before the PLC Write"
Cohesion: 0.18
Nodes (10): Acceptance criteria, Acceptance criteria — evidence, As built, Decisions, Evidence, Finding (confirmed on `d2372fb`), Objective, Remaining limitations (+2 more)

### Community 233 - "ADR-0021 — Monitoring: Alarms and Live Updates"
Cohesion: 0.40
Nodes (4): ADR-0021 — Monitoring: Alarms and Live Updates, Consequences, Context, Decision

### Community 234 - "asset-authoring.test.ts"
Cohesion: 0.15
Nodes (15): dynamic, GET(), notFound(), runtime, AssetStorage, createFileAssetStorage(), getAssetStorage(), ADR-0012 (+7 more)

### Community 235 - "Coding Standards"
Cohesion: 0.18
Nodes (10): Coding Standards, Comments, Dependency policy, Domain boundaries, Error handling, Logging, Naming, Protocol code (+2 more)

### Community 236 - "ADR-0023 — Production Edge Deployment and Transport Security"
Cohesion: 0.40
Nodes (4): ADR-0023 — Production Edge Deployment and Transport Security, Consequences, Context, Decision

### Community 237 - "ADR-0016 — PLC-to-PLC Client Runs in the Client PLC's Runtime"
Cohesion: 0.40
Nodes (4): ADR-0016 — PLC-to-PLC Client Runs in the Client PLC's Runtime, Consequences, Context, Decision

### Community 238 - "scenario-service.ts"
Cohesion: 0.19
Nodes (16): ScenarioOverride, ScenarioStepResult, isExternallyWritable(), ActiveOverride, clearAllOverrides(), listActiveOverrides(), message(), requireFactory() (+8 more)

### Community 239 - "communication/actions.ts"
Cohesion: 0.28
Nodes (13): addMappingAction(), createLinkAction(), linkAction(), number(), run(), configFields(), formField(), createPlcLink() (+5 more)

### Community 240 - "PumpHouse"
Cohesion: 0.16
Nodes (7): asFloat(), boolean(), clamp(), towards(), Event, Event, PumpHouse

### Community 241 - "Web Factory"
Cohesion: 0.12
Nodes (16): As built (TASK-901), As built (TASK-902), As built (TASK-903), As built (TASK-904), As built (TASK-905), Broker and agent onboarding, Commands and setpoints, Connectivity (+8 more)

### Community 242 - "test-packaging.sh"
Cohesion: 0.60
Nodes (3): fail(), ok(), test-packaging.sh script

### Community 243 - "edge-standin.sh"
Cohesion: 0.67
Nodes (3): cleanup(), lab_tool(), edge-standin.sh script

### Community 245 - "web-factory/package.json"
Cohesion: 0.33
Nodes (5): engines, node, name, private, version

### Community 246 - "Z-Factory Thin Client Agent"
Cohesion: 0.17
Nodes (11): As built (TASK-503a), As built (TASK-503b), As built (TASK-503c), Files on the edge, Health, MQTT (TASK-503b), Offline spool (TASK-503c), Running it (+3 more)

### Community 247 - "next-auth.d.ts"
Cohesion: 0.33
Nodes (5): JWT, next-auth, next-auth/jwt, Session, User

### Community 249 - "ADR-0017 — Thin Client Agent Runs From Exported Files"
Cohesion: 0.40
Nodes (4): ADR-0017 — Thin Client Agent Runs From Exported Files, Consequences, Context, Decision

### Community 250 - "ADR-0022 — Cloud Commands and Setpoints"
Cohesion: 0.40
Nodes (4): ADR-0022 — Cloud Commands and Setpoints, Consequences, Context, Decision

### Community 253 - "ADR-0018 — Web Factory Identity, Sign-in and Data Ownership"
Cohesion: 0.40
Nodes (4): ADR-0018 — Web Factory Identity, Sign-in and Data Ownership, Consequences, Context, Decision

### Community 254 - "gateway.ts"
Cohesion: 0.19
Nodes (14): connectionInclude, GatewayConnectionRecord, gatewayRepository, covered(), decideGatewayRead(), decideGatewayWrite(), end(), GATEWAY_CATEGORY_CODES (+6 more)

### Community 255 - "DomainError"
Cohesion: 0.16
Nodes (13): parsePortRange(), runtimePolicyFromEnv(), DomainError, serviceNameFor(), request(), acknowledgeAlarm(), notFound(), notFound() (+5 more)

### Community 256 - "PLC & Industrial Device Source/Data Policy"
Cohesion: 0.25
Nodes (7): Authoritative sources, Capture, Do not store by default, Initial PLC manufacturers, Peripheral manufacturers/models, PLC & Industrial Device Source/Data Policy, Verification

### Community 258 - "events.test.ts"
Cohesion: 0.13
Nodes (19): close(), send(), heartbeat(), alarmCodeLabel(), AlarmEffect, alarmEffects(), alarmState, codes() (+11 more)

### Community 272 - "ADR-0020 — Telemetry Storage, Idempotency and Latest State"
Cohesion: 0.40
Nodes (4): ADR-0020 — Telemetry Storage, Idempotency and Latest State, Consequences, Context, Decision

### Community 273 - "stored-runtime-screens.tsx"
Cohesion: 0.06
Nodes (35): mappingAction(), CommunicationPage(), CommunicationPageProps, dynamic, metadata, dynamic, metadata, ReportPage() (+27 more)

### Community 274 - "process-bridge-runtime.test.ts"
Cohesion: 0.04
Nodes (86): createPrismaClient(), createDockerClient(), dockerOptionsFromHost(), globalForDocker, ADR-0004, DEFAULT_LIMITS, RuntimeLimits, ADR-0004 (+78 more)

### Community 275 - ".advance"
Cohesion: 0.22
Nodes (13): approach(), clamp(), loadTorque(), numeric(), outputsOf(), reportsFault(), sensorSource(), stepLoad() (+5 more)

### Community 276 - "validation/process-module.ts"
Cohesion: 0.13
Nodes (14): MODULE_KEY_PATTERN, config, interlockConditionSchema, interlockExpressionSchema, key, location, moduleAssignmentInputSchema, moduleBindingInputSchema (+6 more)

### Community 277 - "PlcBridge"
Cohesion: 0.27
Nodes (4): deEnergized(), PlcBridge, PlcIo, Signals

### Community 278 - "files/[file]/route.ts"
Cohesion: 0.31
Nodes (11): GET(), notFound(), RFC-4180, Cell, csvCell(), deviceScheduleCsv(), ioScheduleCsv(), tagScheduleCsv() (+3 more)

### Community 279 - "codec.go"
Cohesion: 0.41
Nodes (10): arrange(), Decode(), Encode(), Encoding, Range(), scale(), swap(), TestDecodeMatchesZFactory() (+2 more)

### Community 280 - "live.test.tsx"
Cohesion: 0.12
Nodes (9): LiveTagTableRow, envelope(), FakeEventSource, iso(), reading(), refresh, T0, tagRows() (+1 more)

### Community 281 - "lib/env.ts"
Cohesion: 0.24
Nodes (8): EnvironmentError, parseServerEnv(), postgresUrl, ServerEnv, serverEnvSchema, ADR-0007, ADR-0008, ADR-0012

### Community 282 - "Development Bootstrap Specification"
Cohesion: 0.18
Nodes (10): CI baseline, Commands, Development Bootstrap Specification, Directory skeleton, Docker development prerequisites, Environment variable contract, Graphify, Local stack (TASK-004) (+2 more)

### Community 284 - "engine.test.ts"
Cohesion: 0.25
Nodes (4): SIMULATED_TYPES, DeviceConfig, run(), simulate()

### Community 285 - "ADR-0019 — Broker Access and Agent Connectivity"
Cohesion: 0.40
Nodes (4): ADR-0019 — Broker Access and Agent Connectivity, Consequences, Context, Decision

### Community 288 - "Linear Workflow"
Cohesion: 0.29
Nodes (6): Linear Workflow, Mapping, Required Linear issue body, Status mapping, Sync rule, Workspace

### Community 289 - "Product Definition"
Cohesion: 0.22
Nodes (8): Device/control model, Explicitly out of MVP, Goal, MVP capabilities, Name, Post-MVP process-module roadmap, Primary demo, Product Definition

### Community 290 - "StoredScenarios"
Cohesion: 0.29
Nodes (7): dynamic, metadata, ScenariosPage(), ScenariosPageProps, StoredScenarios(), text(), exampleScenario()

### Community 291 - "TASK-004 — Makefile to Start, Stop and Restart the Local Development Stack"
Cohesion: 0.25
Nodes (7): Acceptance criteria, Evidence (2026-10-08, on the development machine), Implementation, Notes, Owner decisions, Request (2026-10-08), TASK-004 — Makefile to Start, Stop and Restart the Local Development Stack

### Community 292 - "device-parameters.ts"
Cohesion: 0.29
Nodes (7): field(), LOAD_FIELDS, MOTOR_FIELDS, PUMP_FIELDS, seconds(), VALVE_FIELDS, VFD_FIELDS

### Community 293 - "clearTagAlarms"
Cohesion: 0.43
Nodes (7): alarmEvent(), applyEffect(), clearTagAlarms(), serialized(), setTagAlarm(), stamp(), store()

### Community 294 - "main"
Cohesion: 0.62
Nodes (6): env(), envDuration(), envInt(), hostname(), main(), probeHealth()

## Knowledge Gaps
- **2082 isolated node(s):** `printWidth`, `dynamic`, `runtime`, `metadata`, `dynamic` (+2077 more)
  These have ≤1 connection - possible missing edges or undocumented components. (Counts symbols only; 2505 node(s) total have ≤1 connection when file, concept and rationale nodes are included.)
- **34 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `canConnectFrom()` connect `containers.ts` to `process-bridge-runtime.test.ts`, `telemetry-e2e.test.ts`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Why does `docker()` connect `telemetry-e2e.test.ts` to `containers.ts`?**
  _High betweenness centrality (0.114) - this node is a cross-community bridge._
- **Why does `DomainError` connect `DomainError` to `module-io-service.ts`, `process-modules/schema.ts`, `plc-communication-service.ts`, `plc-runtime-service.ts`, `getDb`, `process-module-service.ts`, `wiring-service.ts`, `plc-runtime-view-service.ts`, `gateway-service.ts`, `containers.ts`, `process-bridge-runtime.test.ts`, `asset-authoring-service.ts`, `scene.test.ts`, `lib/services/live-service.ts`, `lib/db/client.ts`, `DeviceSimulatorRuntime`, `normalize.ts`, `engine.test.ts`, `factory-service.ts`, `tag-monitor/monitor.ts`, `gateway-endpoint/runtime.ts`, `requireActor`, `domain/process-module.ts`, `device-sim/engine.ts`, `parseInput`, `modbus/client.ts`, `bridge.ts`, `OpenPlcClient`, `catalog/catalog.test.ts`, `plc-config-view.ts`, `lib/domain/errors.ts`, `simulation-service.ts`, `edge-deployment-service.ts`, `event-service.ts`, `topology-service.ts`, `device-detail-service.ts`, `[architecture]/page.tsx`, `adapter.ts`, `FactorySimulation`, `openplc-adapter.test.ts`, `plc-config-service.ts`, `connection-service.ts`, `factory-crud.test.ts`, `meshy.ts`, `asset-authoring.test.ts`, `scenario-service.ts`, `communication/actions.ts`, `authoring.test.ts`, `domain/plc-communication.ts`, `process-bridge-service.ts`, `process-bridge/runtime.ts`, `catalog-service.ts`, `catalog/schema.ts`?**
  _High betweenness centrality (0.112) - this node is a cross-community bridge._
- **What connects `printWidth`, `dynamic`, `runtime` to the rest of the system?**
  _2082 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `module-io-service.ts` be split into smaller, more focused modules?**
  _Cohesion score 0.05423728813559322 - nodes in this community are weakly interconnected._
- **Should `devDependencies` be split into smaller, more focused modules?**
  _Cohesion score 0.06451612903225806 - nodes in this community are weakly interconnected._
- **Should `Engine` be split into smaller, more focused modules?**
  _Cohesion score 0.14082503556187767 - nodes in this community are weakly interconnected._