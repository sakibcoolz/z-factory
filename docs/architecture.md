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
- `lib/domain/`: factory/device/network/control domain logic.
- `lib/db/`: Prisma client and repositories.
- `lib/docker/`: Docker Engine integration; server-only.
- `lib/runtimes/`: OpenPLC and device-simulator runtime adapters.
- `lib/protocols/`: Modbus abstractions, register codecs and mappings.
- `lib/events/`: internal event bus and SSE/WebSocket transport.
- `lib/catalog/`: normalized PLC/peripheral catalog access.
- `lib/validation/`: compatibility, I/O occupancy and domain invariants.
- `lib/export/`: engineering report/config package generation.

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
