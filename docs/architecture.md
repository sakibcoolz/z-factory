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
                      /          |           \
             OpenPLC PLCs   Device Simulator   Gateway(optional)
                 |              |   |
              Modbus TCP <------+   +--> VFD/Motor/Pump/Valve/Sensor state
                 |
          published endpoint when external access is enabled
                 |
       Physical Industrial Edge Gateway
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
- `lib/runtimes/`: runtime adapters; `openplc/` holds the OpenPLC Runtime v4 adapter, its REST client, the STruC++ compile worker and the bundle composer (ADR-0008); server-only.
- `lib/protocols/`: Modbus TCP client today; register codecs and mappings with TASK-203; server-only.
- `lib/events/`: internal event bus and SSE/WebSocket transport.
- `lib/catalog/`: normalized PLC/peripheral catalog access.
- `lib/validation/`: Zod schemas for untrusted input plus pure compatibility, I/O occupancy and domain invariants.
- `lib/export/`: engineering report/config package generation.
- `lib/navigation/`: route builders; every screen URL is built here from Z-Factory IDs.
- `lib/fixtures/`: static design fixtures behind the wireframe screens (TASK-104). Temporary: each fixture is replaced by its owning service/task and nothing outside `app/` and `components/` may depend on it.

## Frontend toolchain
Next.js 16 (App Router, Turbopack) · React 19 · TypeScript 6 strict · Tailwind CSS 4 (theme tokens in `app/globals.css`) · Prisma 7 with the `pg` driver adapter · dockerode 5 · STruC++ 0.7 (separate process) · fflate · Zod 4 · ESLint 9 with `eslint-config-next` · Prettier 3 · Vitest 5 + Testing Library (jsdom). Screens are server components; client components are limited to interactive leaves (the factory form and delete confirmation) that receive server actions as props. Versions, commands and the environment contract are fixed in `docs/bootstrap.md`.

## Server-only boundary
Modules under `lib/db/`, `lib/services/`, `lib/auth/`, `lib/docker/`, `lib/runtimes/`, `lib/protocols/` and `lib/env.ts` import `server-only`. `components/**` may not import them (ESLint `no-restricted-imports`); pages under `app/` load data on the server and pass plain props down.

## Factory isolation
Each factory receives one isolated Docker network by default, e.g. `zfactory_<factory_id>`. Containers join networks; Dockerfiles do not.

Use deterministic Docker DNS/service names inside a factory. Do not hard-code container IPs.

## PLC abstraction
The UI creates/edits a PLC, not a Dockerfile.

Backend translation:
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

## Control authority
PLC runtime is the control authority.

```text
Gateway/UI -> PLC command/setpoint -> PLC logic -> simulated field device
simulated device -> PLC feedback/status/alarm -> Gateway/UI
```

Never bypass PLC logic by writing gateway commands directly into motor/pump/VFD state.

## Device simulation architecture
MVP uses a shared device-simulator runtime capable of hosting many factory-specific state machines. It may manage VFD, motor, pump, fan, conveyor, valve, sensor, switch and process-state instances. Avoid one container per simple peripheral unless isolation or protocol fidelity requires it.

## Live-state boundary
- Runtime/OpenPLC/device simulator: authoritative live state.
- PostgreSQL: catalog/configuration/mapping/version/audit/event/alarm/history and selected current-state snapshots.
- SSE is the initial server-to-browser channel; WebSockets may be introduced when bidirectional low-latency behavior justifies them.

## Runtime adapter contract
Adapters support the relevant subset of:
`create`, `configure`, `start`, `stop`, `restart`, `remove`, `inspect`, `deployProgram`, `readTags`, `writeTag`, `getPorts`, `getTelemetry`, `health`.

## Security
Docker socket/API access is privileged and MUST remain server-side. Production should use a constrained Docker API proxy or equivalent least-privilege boundary.

## Future split
A separate orchestration/simulation service may be introduced only when scale, security or fidelity requires it and after an ADR.
