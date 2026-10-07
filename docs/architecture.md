# Architecture

## Decision
The MVP is a single Next.js TypeScript application. It contains browser UI, server actions/route handlers, PostgreSQL/Prisma access, event streaming endpoints, domain services, protocol adapters, and server-only Docker orchestration.

```text
Browser
  |
Next.js
  |-- UI / SSR / Server Components
  |-- Route Handlers / Server Actions
  |-- Domain Services
  |-- Catalog + Validation
  |-- Docker Orchestrator (server-only)
  |-- Runtime Adapters
  |-- Modbus Mapping/Client Services
  |-- Event/Telemetry Service
  |-- Export Service
  |-- Prisma
  |
PostgreSQL                 Docker Engine
                              |
                       Factory Docker Network
                    /            |             \
              OpenPLC-A      OpenPLC-B     Device Simulator
                  |              |
                  +-- Modbus TCP-+
                                 |
                           Gateway(optional)
```

## Layering
- `app/`: routes, pages, route handlers, server actions.
- `components/`: UI only.
- `lib/domain/`: pure domain vocabulary, rules and typed errors; importable anywhere.
- `lib/services/`: domain services that orchestrate validation and repositories; server-only.
- `lib/env.ts`: validated environment contract; server-only.
- `lib/auth/`: the authorization boundary `requireActor()` (ADR-0007); server-only.
- `lib/db/`: Prisma client, repositories and database-error translation; server-only.
- `lib/docker/`: Docker Engine integration (dockerode): policy and image allow-list, hardened container specs, factory networks, port validation, lifecycle; server-only. See `docs/docker-runtime.md` → Implementation.
- `lib/runtimes/`: runtime adapters; `openplc/` holds the OpenPLC Runtime v4 adapter, its REST client, the STruC++ compile worker and the bundle composer (ADR-0009); `device-sim/` holds the shared device simulator: behaviour models, the per-factory engine, the PLC bridge and the tick runtime (ADR-0010); `tag-monitor/` holds the live-tag monitor that reads running PLCs and the telemetry sampling rule (ADR-0011); `gateway-endpoint/` holds the endpoints external gateways connect to, which hand out mapped tags only (ADR-0013); server-only.
- `lib/protocols/`: Modbus abstractions: TCP client, typed register codecs, the located-address → Modbus mapping of the OpenPLC runtime, and the Modbus TCP server external gateways talk to (ADR-0013); PLC-to-PLC mappings follow (Phase 07); server-only.
- `lib/events/`: in-process event bus, ordered event ids and the server-sent-events encoding (ADR-0011); server-only.
- `lib/catalog/`: normalized PLC/peripheral catalog access.
- `lib/assets/`: catalog 3D asset files: the storage directory behind an interface and the GLB check (ADR-0012); and what authoring an asset needs: the prompt built from catalog metadata, normalization of a GLB, and the Meshy client (TASK-403); server-only.
- `scripts/`: commands a developer runs on the server. `catalog-assets.ts` (`npm run assets`) is the only caller of the asset authoring service. `edge-client.mjs` is a dependency-free Modbus client that stands in for an edge device; it imports nothing of the application.
- `lib/process-modules/`: process-module type definitions as data: their shape and rules, the shipped types and the writer used by the seed (`docs/process-modules.md`). The rules of modules are pure (`lib/domain/process-module.ts`); the service is `lib/services/process-module-service.ts`.
- `lib/demo/`: the pump station of the MVP demo as data and program text (`docs/demo-runbook.md`); pure. The demo service builds a stored factory from it.
- `lib/scene/`: pure rules of the 3D view: floor layout from the designer's canvas, generic shapes and footprints per category.
- `lib/validation/`: Zod schemas for untrusted input plus pure compatibility, I/O occupancy and domain invariants. The rules of one wire between two endpoints are `lib/validation/wiring.ts` (ADR-0014).
- `lib/export/`: engineering report/config package generation.
- `lib/navigation/`: route builders; every screen URL is built here from Z-Factory IDs.

## Frontend toolchain
Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 strict · Tailwind CSS 4 (theme tokens in `app/globals.css`) · React Flow 12 (`@xyflow/react`, designer canvas) · three.js with React Three Fiber 9 and drei 10 (3D view, loaded only on that screen) · Prisma 7 with the `pg` driver adapter · dockerode 5 · STruC++ 0.7 (separate process) · fflate · Zod 4 · ESLint 9 with `eslint-config-next` · Prettier 3 · Vitest 5 + Testing Library (jsdom). Screens are server components; client components are limited to interactive leaves (the factory form and delete confirmation) that receive server actions as props. Versions, commands and the environment contract are fixed in `docs/bootstrap.md`.

## Server-only boundary
Modules under `lib/db/`, `lib/services/`, `lib/auth/`, `lib/docker/`, `lib/runtimes/`, `lib/protocols/`, `lib/events/` and `lib/env.ts` import `server-only`. `components/**` may not import them (ESLint `no-restricted-imports`); pages under `app/` load data on the server and pass plain props down.

## Factory isolation
Each factory receives one isolated Docker network by default, e.g. `zfactory_<factory_id>`.

Use deterministic Docker DNS/service names inside a factory. Do not hard-code container IPs.

## PLC abstraction
The UI creates/edits a PLC, not a Dockerfile.

```text
PLC Form
 -> validate hardware profile
 -> create/update PLC instance
 -> generate I/O + tag + Modbus mapping
 -> generate/version PLC program/runtime config
 -> configure reusable OpenPLC image/container
 -> attach to factory network
 -> start/reload/recreate as required
 -> health check
 -> publish runtime/events to UI
```

Program/config changes should not rebuild an image unless the image itself must change.

## PLC program deployment
Each PLC container uses the same reusable OpenPLC runtime image but receives its own program/configuration.

```text
ProgramVersion
 -> compile/generate OpenPLC artifacts
 -> deployProgram()
 -> mount/inject PLC-specific program + I/O + Modbus config
 -> reload/restart PLC runtime as required
 -> run independent scan cycle
```

A factory may therefore run many OpenPLC containers from the same base image while each PLC executes a different control program.

## Canonical wiring (TASK-307, ADR-0014)
One wire between two exact endpoints is the only description of wiring. An endpoint is a terminal of a device, an I/O point of a PLC or a communication port; what it accepts and how many wires it takes is catalog data.

```text
designer wiring editor
  -> lib/validation/wiring.ts   (one rule set: kind, direction, class, standard, protocol, duplicate, occupancy)
  -> lib/services/wiring-service.ts   (lock both devices, validate, store one DeviceConnection)
       -> a wire to a PLC channel also creates the tag at the channel's address
  -> read by: tags and Modbus map, simulator bridge, PLC export, topology, device hierarchy, 3D
```

Nothing is wired because two devices are connected, and no other screen writes wiring: the PLC's Connections and I/O Mapping screens are projections. The editor shows, for every pair of endpoints, the refusal of the same rule function the service applies when the wire is stored.

### Physical conductors (TASK-405)
The scene's connections carry the stored wires of a wiring edge as `conductors` (`getFactoryScene` reads them from `getTopology`, which reads the canonical wiring of ADR-0014). The renderer draws one line per conductor (`lib/scene/conductors.ts` lays the bundle and styles each kind) and keeps one logical line for a relationship that is not wiring. The 3D view owns no wiring of its own and invents no conductor from the kind of device.

## Programmable device abstraction
Implemented in TASK-308 (`docs/programmable-devices.md` → Implementation): `DeviceModel.capabilities` is catalog data; `lib/domain/device-capabilities.ts` decides from it which screens a device has and whether the program workflow may run; the runtime service refuses a program for a model without the capability or in a language the adapter does not compile before any side effect; a generic RTU runs the PLC workflow unchanged. The existing PLC program/version workflow is generalized through capability-driven adapters.

```text
Catalog model capabilities
 -> device instance UI
 -> Program / Script / Parameters editor
 -> immutable version
 -> validator/compiler when applicable
 -> runtime adapter
 -> canonical tags/I/O/connections
```

PLC, RTU, drive and controller screens are not hard-coded from category names. The exact model declares whether it is programmable, scriptable or parameter-configurable. OpenPLC remains the first PLC runtime. RTU support is adapter/capability based. VFDs are parameter-first unless the selected profile explicitly supports logic.

The program/configuration layer consumes TASK-307 canonical wiring and must not create a competing mapping source.

## PLC I/O authority boundary
ADR-0015 defines the control boundary.

```text
LOCAL PHYSICAL TARGET
Field input -> PLC input image -> PLC program -> PLC output image -> field output

VIRTUAL SIMULATION
Simulator input -> simulation bridge -> PLC input image/memory -> PLC program
PLC output image -> simulator/device model -> feedback -> PLC input image/memory

REMOTE COMMAND
Gateway/UI -> command/setpoint tag -> PLC program -> PLC output image -> device
```

Rules:
- The PLC scan cycle owns local output state.
- Modbus is not the default mechanism for driving a PLC's own physical output pin.
- Runtime REST API manages the runtime/program; it does not drive field I/O.
- External writes are limited to explicit command/setpoint/communication tags.
- Physical I/O mapping is target-adapter-specific and separate from logical program/wiring.
- Modbus remains valid where the actual industrial topology uses Modbus remote I/O or Modbus-capable devices.

As built (TASK-205): every tag has one owner (`tagAuthority`: program output, field input, simulated feedback, external command, program memory), only external command memory can be written from outside — by the tag service, the gateway and the raw register write alike — and a tag on an I/O point is never writable, in the service and as a database constraint. The physical target adapter contract is in `docs/openplc-runtime.md`.

## Control authority
PLC runtime is the control authority.

```text
Gateway/UI -> PLC command/setpoint -> PLC logic -> simulated field device
simulated device -> PLC feedback/status/alarm -> Gateway/UI
```

Never bypass PLC logic by writing gateway commands directly into device state.

## PLC-to-PLC communication — Phase 07
PLC instances remain independent runtimes. Communication is explicit and protocol-driven.

```text
PLC-A local communication tag
        |
        v
Modbus TCP Client Mapping
        |
        | factory Docker network
        v
PLC-B Modbus TCP Server
        |
        v
PLC-B tag/register
        |
        v
PLC-B local control logic
```

Rules:
- First protocol: Modbus TCP.
- Client/server role is configured per PLC relationship.
- Read mappings copy PLC-B feedback/status/process values into PLC-A communication tags.
- Write mappings target only explicitly writable PLC-B command/setpoint endpoints.
- PLC-B remains responsible for local interlocks and final device outputs.
- Communication uses deterministic Docker DNS/service names, not fixed IP addresses.
- Host-published ports are unnecessary for same-factory internal PLC traffic.
- Cross-factory direct PLC links are rejected in Phase 07.
- Disconnected/stale quality and reconnect behavior are observable.

As built (TASK-701): a link is a `PlcCommunicationConnection` between two programmable controllers of one factory, with the relationship (`COMMUNICATES_WITH`, `SUPERVISES`), the protocol (`MODBUS_TCP`), which end is the client, the server's deterministic service name on the factory network, port, unit id, poll interval and an enabled flag. The rules are pure (`lib/domain/plc-communication.ts`: self, factory, controller, server capability) and the database repeats the structural ones. Every change is a `ConfigurationVersion` of scope `PLC_COMMUNICATION` and a `PLC_LINK_CHANGED` event; the link is exported by PLC names (`z-factory.plc-link`) and listed in both PLCs' engineering exports. A link grants no write: mappings (TASK-702) do, and only on explicitly writable endpoints. The runtime that drives a link is TASK-703, the screens TASK-704.

As built (TASK-702): a mapping joins a tag of the client and a tag of the server. A READ fills free input (`%I`) or memory (`%M`) of the client (which becomes a `LINK_INPUT` tag); a WRITE sends a value the client's program computes to a writable command or setpoint of the server, so a gateway's command on the client never reaches the server past the client's program, and the server's own program still decides. One writer per value across links, enforced in the service and by partial unique indexes. Mapping changes are versions of the link.

As built (TASK-703, ADR-0016): the client PLC's own runtime is the Modbus TCP client. Deploying the client's program also deploys its enabled links as the configuration of the OpenPLC runtime's Modbus master plugin (`conf/modbus_master.json`): one device per link, addressed by the server's service name on the factory network, one point per enabled mapping with its interval. The exchange runs container to container; no host port and no Z-Factory process sit in the path, and a link that fails stops nothing else (the master keeps the last value of a READ). Z-Factory watches the links (`PlcLinkMonitorRuntime`, started and stopped with the factory): STALE while the client does not run the link's current version, DISCONNECTED while the server does not answer, GOOD otherwise; each change is a `CONNECTION_DOWN`/`CONNECTION_UP` event with `link: plc-link`. A changed link takes effect at the client's next deployment; the deployment snapshot records which link versions it carries.

As built (TASK-704): links and values are configured on the PLC's Communication screen, drawn as their own client-to-server edge in the topology, and exported with their values in each PLC's engineering report and as `link.json`. An end-to-end test runs the seven scenarios of the task against two real OpenPLC runtimes.

## Device simulation architecture
MVP uses a shared device-simulator runtime capable of hosting many factory-specific state machines. Avoid one container per simple peripheral unless isolation or protocol fidelity requires it.

Implemented in TASK-204 (ADR-0010): the simulator runs inside the server process and reaches each PLC through its published Modbus endpoint. Per cycle it reads the tags PLC logic drives, advances the device models, and writes feedback to memory-address tags. See `docs/device-simulation.md` → Implementation.

Generic device simulation and process simulation are separate concerns. A process module composes existing factory device instances and allocates its logical PLC I/O.

### Post-MVP process simulation
Phase 06 adds the ADR-0008 Go process-simulation service behind explicit adapters. This is additive and must not rewrite the Phase 02–05 runtime contracts.

As built (TASK-602, `docs/process-simulation.md`): `services/process-sim` is a Go service with a deterministic tick loop that hosts many process-module instances in one process, behind a token-protected JSON API. Models (`PUMP_HOUSE`, `TANK`) are pure functions of parameters, state, inputs and a fixed time step; state lives in memory and a restart starts empty. Z-Factory speaks to it through `lib/runtimes/process-sim/client.ts` (server-only; contract types in `lib/domain/process-sim.ts`). Nothing binds its values to PLC tags yet: that is the bridge of TASK-603.

```text
Next.js / Z-Factory configuration
          |
          v
Go Process Simulation Service
          |
          v
Modbus/runtime adapter <-> OpenPLC tags
          ^
          |
      PLC control logic
```

The Go service computes process response; OpenPLC remains the control authority. Specific machine/process models are created later as module definitions and are not hard-coded into the generic framework.

## Catalog 3D asset pipeline — Phase 04
Meshy MCP is an authoring-time provider for reusable catalog assets, not a runtime dependency.

```text
Catalog model metadata
        |
        v
Meshy MCP (server/developer-side)
        |
        v
Generated 3D artifact
        |
        v
Normalize + validate GLB
        |
        v
Z-Factory-controlled asset storage/version
        |
        v
Catalog model 3D asset reference
        |
        v
Factory instance -> React Three Fiber renderer
```

Rules:
- Runtime rendering loads a stored GLB; it does not call Meshy.
- One catalog asset can be reused by many factory instances.
- Live device state is a renderer overlay/material/outline concern and does not mutate or regenerate the GLB.
- RUNNING uses green emphasis; FAULTED uses red emphasis and propagates red visual state to affected connection lines.
- 3D relationship lines come from the canonical connection graph.
- Asset absence/failure uses a category fallback rather than blocking the catalog or factory.
- Meshy credentials and provider calls remain server/developer-side.
- Process/module-specific 3D authoring is deferred beyond Phase 04.

### As built (TASK-402, ADR-0012)
- The asset reference is `Catalog3dAsset` (versions per catalog model) with `DeviceModel.active3dAssetId`; files are in `ASSET_STORAGE_DIR` and go out through `GET /assets/models/<asset id>/model.glb`.
- `getFactoryScene` builds the scene from `getTopology`: the same devices, connections and stored states as the designer and the 2D view, each device where the designer has it. The scene adds the model's asset and the instance's rotation and scale.
- The renderer loads each asset file once and draws a copy per instance, fitted into the space of the device's category. A model without a ready asset, or an asset that fails to load, is drawn as the category's generic shape.
- Registration of a file (`registerCatalogAsset`) validates and versions it.
- Runtime state (TASK-404): the server follows recorded events with a `devices` message on the live stream; `lib/scene/state.ts` turns each device's state, and whether the stream vouches for it, into an appearance with the same tone rules as the pills and the 2D topology (`runtimeStateTone`, `edgeTone`). The renderer draws it as overlays around the model and along connections. The loaded asset is never modified.

### Authoring as built (TASK-403)
```text
npm run assets -- generate <model>            (a developer, on the server)
        |
        v
asset-authoring-service
  prompt from catalog metadata (generic shape; never a vendor's name)
  -> Catalog3dAsset version, PENDING           (the model keeps rendering what it had)
  -> Meshy text-to-3D: mesh job, then texture job   (job ids and progress on the row)
  -> download GLB from the provider's host
  -> check (lib/assets/glb.ts) -> normalize (lib/assets/normalize.ts) -> check again
  -> file into ASSET_STORAGE_DIR, version READY and active
     or version FAILED with the reason        (the model keeps rendering what it had)
```
- **Who calls the provider.** Only `lib/services/asset-authoring-service.ts`, and only `scripts/catalog-assets.ts` calls that. No page, route handler, server action or component imports either; a test checks the import graph. Opening the 3D view or the catalog therefore cannot generate anything or spend credits.
- **Normalization** adds one root node to the file that carries the whole transform; geometry and textures stay byte for byte. Afterwards Y is up, the front faces +Z, one unit is one metre, the model fills the space of its device category (`lib/scene/placeholders.ts`) and stands with the middle of its footprint on the origin. The renderer applies nothing more to such a file (`scale` 1).
- **Jobs survive interruptions.** The provider's job ids are stored on the pending version; `resume` continues from them without requesting, or paying for, anything again. A model has one pending job at a time.
- **Other sources.** A file made in another tool, or generated through the Meshy tools of a coding session, enters through `import` with the same check and normalization. `share` gives a model the file another model of the same shape already has.
- **Versions.** Every generation, import or share is a new version. `retire` takes a version out of use; the newest other ready version, or the category's generic shape, is rendered instead. `activate` goes back to an earlier ready version.

## Live-state boundary
- Runtime/OpenPLC/device simulator: authoritative live state.
- PostgreSQL: catalog/configuration/mapping/version/audit/event/alarm/history and selected current-state snapshots.
- SSE is the initial server-to-browser channel; WebSockets may be introduced when bidirectional low-latency behavior justifies them.

### Live channel (TASK-401, ADR-0011)
```text
OpenPLC runtime --Modbus read--> tag monitor (memory: value, quality, read time)
device simulator (memory: device state) ----.            |
runtime / simulation / tag services --events--> event service --> RuntimeEvent, AlarmEvent
                                             |            |            (PostgreSQL: history)
                                             v            v
                                        in-process bus  TelemetrySample (sampled)
                                             |
                             GET /factories/[id]/stream (SSE)
                                             |
                       browser: Live Tags, Events, topology and runtime screens
```
- The tag monitor and the simulator are the only sources of live values. The stream and the live screens read their memory; the database is written to, and read only for history.
- Every runtime event passes through one recording path that fixes its order. A reconnecting browser is sent the events after the last one it saw, then the whole current state.
- A stored state no runtime stands behind is not shown as live: a simulated device is stopped when no simulation runs, whatever was last stored, and the stored state is corrected.

### Factory lifecycle (TASK-502)
`startFactory` brings a factory up in the order a plant is started: every PLC runtime, then live monitoring, then the device simulation, then the gateway endpoints. `stopFactory` takes the simulation down first, so the last device states are stored while the PLCs still answer, then the PLCs. Both only call the operations the single screens offer (`startPlc`, `startFactorySimulation`, `syncGatewayEndpoints`, …); there is no second way to start anything.

### External gateways (TASK-501, ADR-0013)
```text
edge device (LAN) --Modbus TCP--> gateway endpoint in the server process
                                     reads of mapped tags  --> PLC Modbus server (loopback)
                                     writes of writable mappings --> tag service (source GATEWAY)
                                                                       --> DeviceCommand, events
                                                                       --> PLC command/setpoint tag --> PLC logic
```
- An external device never reaches a PLC's own Modbus port, which cannot tell a command from a feedback value. It reaches an endpoint that knows the tag registry: unmapped addresses are refused, and a write is possible only where a command or setpoint tag was mapped as writable.
- A gateway is a device of the factory; its connection to a PLC stores the endpoint's address, port and unit id, and its mappings the tags it is given. The rules are pure (`lib/domain/gateway.ts`).
- Endpoints are state of the server process, like the simulator and the tag monitor, and are opened from the stored connections.

## Runtime adapter contract
Adapters support the relevant subset of:
`create`, `configure`, `start`, `stop`, `restart`, `remove`, `inspect`, `deployProgram`, `readTags`, `writeTag`, `getPorts`, `getTelemetry`, `health`.

## Security
Docker socket/API access is privileged and MUST remain server-side. Production should use a constrained Docker API proxy or equivalent least-privilege boundary.

## Future split
A separate simulation service is approved only for Phase 06+ by ADR-0008. The MVP remains the single Next.js application from ADR-0001. Any broader orchestration/backend split requires another ADR.


## Simulation test-control boundary (Phase 08)
Phase 08 adds controlled test input manipulation without weakening ADR-0015.

```text
UI -> Z-Factory server -> Go simulation override API
   -> effective simulated input
   -> bridge -> PLC input
   -> PLC program
   -> PLC output
   -> bridge -> simulated actuator/process
   -> actual feedback -> PLC input
```

The UI changes simulator runtime state, never PLC local outputs. The Go service exposes AUTO, MANUAL_OVERRIDE and SCENARIO semantics for supported simulated inputs (as built in TASK-801 for the models' measured outputs: `docs/process-simulation.md` → Overrides). Program-generated PLC outputs are delivered to simulated devices through the bridge. Actual device/process feedback returns to PLC inputs. This is the canonical closed-loop testing model.


## Z-Factory Thin Client Agent — Phase 05 follow-up (TASK-503)

The production external edge component is a standalone Go thin client, separate from the Next.js server and separate from the Phase 06 process simulator.

```text
Z-Factory export
 -> versioned per-PLC JSON
 -> edge staging/active directories
 -> Z-Factory Thin Client Agent (Go)
      -> config validator + reconciler
      -> Device Supervisor
           -> dynamic PLC worker 1 -- Modbus TCP --> PLC
           -> dynamic PLC worker 2 -- Modbus TCP --> PLC
           -> ... N = active PLC configs
      -> bounded telemetry queue
      -> durable local spool
      -> bounded MQTT publisher pool -> cloud
      <- MQTT command subscriber <- cloud
           -> command router -> target PLC worker
           -> validated command/setpoint mapping only
```

Rules:
- no central SQL/PostgreSQL dependency
- edge desired state comes from versioned exported PLC JSON
- invalid candidates never replace last-known-good active config
- PLC workers are dynamic, supervised and fault-isolated; count derives from active configs
- one slow/offline PLC cannot block others
- queues/publishers are bounded with explicit backpressure/reconnect/spool limits
- MQTT/cloud failure does not stop local PLC polling
- telemetry can be spooled and replayed at a controlled rate
- MQTT commands route by stable PLC/mapping identity, validate against exported writable allow-list, and use command ids/idempotency
- remote writes target command/setpoint communication tags only; PLC scan-cycle logic/interlocks remain authoritative for local physical outputs (ADR-0015)
- hot add/update/remove reconciles only affected workers
- production secrets are not exported as plaintext JSON
- `scripts/edge-client.mjs` remains a test/reference client; TASK-503 provides the deployable Go agent

As built (TASK-503a, ADR-0017): `services/zfactory-thin-client-agent/` (binary `zfactory-agent`) and the per-PLC export `GET /factories/{factory}/plcs/{plc}/edge.json` (`exportEdgeDeployment`). Done so far:
- checksummed deployment files with a staging/active/rejected lifecycle and hot reload by PLC;
- one supervised Modbus worker per PLC, with a global poll limit and backoff;
- a bounded telemetry queue;
- a local health, status and metrics endpoint.

As built (TASK-503b): the MQTT uplink and command downlink:
- telemetry, retained PLC state, heartbeat, and an online/offline will;
- commands checked against the exported allow-list, configuration version and expiry, written once by command id, and answered ACCEPTED/REJECTED/APPLIED/FAILED.

As built (TASK-503c): a bounded bbolt spool that keeps telemetry while the cloud is away, survives a restart, and is replayed at a fixed rate beside live telemetry. TASK-503 is complete. Details: `docs/thin-client-agent.md`.


## Web Factory cloud application — Phase 09 / MVP 2

**Web Factory** is the cloud-hosted TypeScript application that receives and presents the data produced by Z-Factory Thin Client Agents.

```text
PLCs
  |
  | Modbus / supported industrial protocols
  v
Z-Factory Thin Client Agent (Go)
  |
  | secure MQTT
  v
MQTT Broker
  |
  v
Web Factory (TypeScript / Next.js / Node.js)
  |-- server-side MQTT consumers
  |-- telemetry/state/event ingestion
  |-- cloud persistence
  |-- latest-state projection
  |-- dashboards / live UI
  |-- auth / authorization
  |-- command validation + audit
  |-- server-side MQTT publisher
  |
  | command topic
  v
MQTT Broker -> Thin Client Agent -> allowed command/setpoint -> PLC logic
```

As built (TASK-901, ADR-0018):
- `apps/web-factory/`, a separate Next.js app with its own database `web_factory`;
- Auth.js e-mail/password sign-in with database-checked sessions;
- VIEWER/OPERATOR/ADMIN roles per organization;
- the identity model: organization, site, agent, factory, PLC, tags, modules, audit;
- PLC registration from the edge deployment file, health and readiness, and a server-only MQTT boundary.

As built (TASK-902, ADR-0019):
- **Broker:** Mosquitto with Dynamic Security. Each agent gets its own broker client, bound to its client id, with a role for its own topics only. Web Factory issues, rotates and revokes it and shows the password once.
- **Ingestion:** one server-side MQTT 5 connection per Web Factory process, with growing reconnect delays. It ingests status, heartbeat and PLC state in order per agent; replays and duplicates change nothing.
- **Connectivity:** projected on read as UNKNOWN, ONLINE, DEGRADED or OFFLINE, timed by Web Factory's clock.

As built (TASK-903, ADR-0020):
- **History:** telemetry is kept in PostgreSQL as one row per tag per poll, in a `telemetry` schema partitioned by day. It is retained 30 days by default, by dropping partitions.
- **Duplicates:** a batch is identified by its PLC and poll time, so a redelivered or replayed batch is stored once.
- **Latest state:** keyed by tag, newest poll wins. STALE and DISCONNECTED are projected on read.
- **Ingestion:** bounded, sharded by PLC, and observable. Web Factory's broker session is persistent, so nothing published while it is away is lost.
- **API:** `/api/v1` serves latest values, history, events and connection history, scoped to the tenant.

As built (TASK-904, ADR-0021):
- **Alarms:** PLC alarm tags, PLC connections and agents raise them, through one sweep with one active alarm per condition. Operators and admins acknowledge.
- **Live updates:** server-sent events per scope, built from the database and checked against the actor on every update.
- **Charts:** built-in SVG.
- **Navigation:** site, factory, module, agent, PLC, tag.

As built (TASK-905, ADR-0022):
- **Checks:** commands and setpoints only to registered command and setpoint tags, from operators and admins, checked against the deployment and the agent's reachability before publishing.
- **Delivery:** published with QoS 1 under Web Factory's command-only broker role, then checked again by the agent's allow-list.
- **Tracking:** requested → published → accepted → applied, failed, rejected or timed out, audited throughout.
- **No double actuation:** request keys in Web Factory, command ids at the agent.
- **Authority:** the PLC program decides what follows a written command.

As built (TASK-906, ADR-0023):
- **Deployment:** reproducible static builds for amd64, arm64 and armv7, with checksums. A checksum-checking systemd installer with a hardened unit, and a distroless non-root image of the same binary.
- **Transport:** MQTT over TLS only in production.
- **Observability:** the agent's goroutines, memory, CPU, poll latency, spool and command counters on `/metrics`.
- **Validation:** a production-like stand-in run proves every failure mode on one machine. The run on physical hardware is an open checklist (`docs/edge-deployment.md`).

Details: `docs/web-factory.md`.

Rules:
- Web Factory is a separate cloud application from the edge Go agent.
- MQTT is server-to-server/agent transport; production browser clients do not receive broker credentials.
- Thin Client telemetry, PLC state and agent heartbeat are consumed by Web Factory server-side.
- Web Factory owns cloud persistence/history and user-facing monitoring views.
- Web Factory may publish only authorized command/setpoint requests; the Thin Client independently re-validates the exported allow-list before Modbus write.
- Command lifecycle is auditable through command ids and acknowledgements.
- Browser/UI never connects directly to PLC Modbus endpoints.
- PLC scan-cycle logic/interlocks remain the final authority for local outputs.
