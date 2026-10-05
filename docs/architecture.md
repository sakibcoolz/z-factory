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
- `lib/runtimes/`: runtime adapters; `openplc/` holds the OpenPLC Runtime v4 adapter, its REST client, the STruC++ compile worker and the bundle composer (ADR-0009); `device-sim/` holds the shared device simulator: behaviour models, the per-factory engine, the PLC bridge and the tick runtime (ADR-0010); `tag-monitor/` holds the live-tag monitor that reads running PLCs and the telemetry sampling rule (ADR-0011); server-only.
- `lib/protocols/`: Modbus abstractions: TCP client, typed register codecs and the located-address → Modbus mapping of the OpenPLC runtime; gateway and PLC-to-PLC mappings follow (Phase 05, Phase 07); server-only.
- `lib/events/`: in-process event bus, ordered event ids and the server-sent-events encoding (ADR-0011); server-only.
- `lib/catalog/`: normalized PLC/peripheral catalog access.
- `lib/assets/`: catalog 3D asset files: the storage directory behind an interface and the GLB check (ADR-0012); server-only.
- `lib/scene/`: pure rules of the 3D view: floor layout from the designer's canvas, generic shapes and footprints per category.
- `lib/validation/`: Zod schemas for untrusted input plus pure compatibility, I/O occupancy and domain invariants.
- `lib/export/`: engineering report/config package generation.
- `lib/navigation/`: route builders; every screen URL is built here from Z-Factory IDs.
- `lib/fixtures/`: static design fixtures behind the wireframe screens (TASK-104). Temporary: each fixture is replaced by its owning service/task and nothing outside `app/` and `components/` may depend on it.

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

## Device simulation architecture
MVP uses a shared device-simulator runtime capable of hosting many factory-specific state machines. Avoid one container per simple peripheral unless isolation or protocol fidelity requires it.

Implemented in TASK-204 (ADR-0010): the simulator runs inside the server process and reaches each PLC through its published Modbus endpoint. Per cycle it reads the tags PLC logic drives, advances the device models, and writes feedback to memory-address tags. See `docs/device-simulation.md` → Implementation.

Generic device simulation and process simulation are separate concerns. A process module composes existing factory device instances and allocates its logical PLC I/O.

### Post-MVP process simulation
Phase 06 may add the ADR-0008 Go process-simulation service behind explicit adapters. This is additive and must not rewrite the Phase 02–05 runtime contracts.

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
- Registration of a file (`registerCatalogAsset`) validates and versions it. Generating files with Meshy, normalizing them and the authoring workflow are TASK-403.
- Runtime state (TASK-404): the server follows recorded events with a `devices` message on the live stream; `lib/scene/state.ts` turns each device's state, and whether the stream vouches for it, into an appearance with the same tone rules as the pills and the 2D topology (`runtimeStateTone`, `edgeTone`). The renderer draws it as overlays around the model and along connections. The loaded asset is never modified.

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

## Runtime adapter contract
Adapters support the relevant subset of:
`create`, `configure`, `start`, `stop`, `restart`, `remove`, `inspect`, `deployProgram`, `readTags`, `writeTag`, `getPorts`, `getTelemetry`, `health`.

## Security
Docker socket/API access is privileged and MUST remain server-side. Production should use a constrained Docker API proxy or equivalent least-privilege boundary.

## Future split
A separate simulation service is approved only for Phase 06+ by ADR-0008. The MVP remains the single Next.js application from ADR-0001. Any broader orchestration/backend split requires another ADR.
