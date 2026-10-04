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
- `lib/docker/`: Docker Engine integration (dockerode): policy and image allow-list, hardened container specs, factory networks, port validation, lifecycle; server-only.
- `lib/runtimes/`: OpenPLC and device-simulator runtime adapters.
- `lib/protocols/`: Modbus abstractions, register codecs, gateway mappings and PLC-to-PLC mappings.
- `lib/events/`: internal event bus and SSE/WebSocket transport.
- `lib/catalog/`: normalized PLC/peripheral catalog access.
- `lib/validation/`: Zod schemas for untrusted input plus pure compatibility, I/O occupancy and domain invariants.
- `lib/export/`: engineering report/config package generation.
- `lib/navigation/`: route builders; every screen URL is built here from Z-Factory IDs.
- `lib/fixtures/`: temporary design fixtures behind wireframe screens.

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
A separate simulation service is approved only for Phase 06+ by ADR-0008. The MVP remains the single Next.js application from ADR-0001. Any broader orchestration/backend split requires another ADR.
