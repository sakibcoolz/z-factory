# Architecture

## Decision
The MVP is a single Next.js TypeScript application. It contains browser UI, server actions/route handlers, database access, event streaming endpoints, and server-only Docker orchestration.

```text
Browser
  |
Next.js
  |-- UI / SSR / Server Components
  |-- Route Handlers / Server Actions
  |-- Domain Services
  |-- Docker Orchestrator (server-only)
  |-- Runtime Adapters
  |-- Event/Telemetry service
  |-- Prisma
  |
PostgreSQL       Docker Engine
                    |
              Factory Docker Network
              |       |       |
           OpenPLC   VFD    Sensors
                    |
               External host ports
                    |
              Raspberry Pi gateway
```

## Layering
- `app/`: routes, pages, route handlers, server actions.
- `components/`: UI only.
- `lib/domain/`: factory/device/network domain logic.
- `lib/db/`: Prisma client and repositories.
- `lib/docker/`: Docker Engine integration; server-only.
- `lib/runtimes/`: OpenPLC/device runtime adapters.
- `lib/protocols/`: Modbus abstractions/mappings.
- `lib/events/`: internal event bus and SSE/WebSocket transport.
- `lib/catalog/`: normalized device catalog access.
- `lib/validation/`: schemas and cross-device compatibility rules.

## Runtime adapter contract
Each runtime adapter should support the relevant subset of:
`create`, `start`, `stop`, `restart`, `remove`, `inspect`, `readTags`, `writeTag`, `getPorts`, `getTelemetry`.

## Network model
Each factory receives an isolated Docker network. MVP external access uses host port publishing rather than placing the Raspberry Pi directly inside the Docker bridge.

## Security
Docker socket access is privileged and MUST remain server-side. Production deployment should use a constrained Docker API proxy or equivalent least-privilege boundary rather than exposing `/var/run/docker.sock` broadly.

## Future split
A separate orchestration service may be introduced only when scale/security requires it and after an ADR.
