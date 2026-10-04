# Development Phases

| Phase | Name | Status | Gate |
|---|---|---|---|
| 00 | Documentation & Foundation | DONE | Docs approved, repo bootstrap plan ready, Linear team chosen |
| 01 | Core Next.js Platform | DONE | Phase 00 Done |
| 02 | OpenPLC, Docker & Device Simulation Runtime | IN PROGRESS | Phase 01 Done |
| 03 | Factory Designer, Device Modeling & PLC Export | PLANNED | Phase 02 core runtime usable |
| 04 | Events, Telemetry & 3D | PLANNED | Factory topology/runtime stable |
| 05 | External Gateway MVP | PLANNED | Modbus runtime externally reachable |
| 06 | Process Module Framework & Go Simulation Service | PLANNED | Phase 02–05 foundations stable; ADR-0008 |
| 07 | Boiler Process Module | PLANNED | Phase 06 exit criteria met |

Cross-cutting requirements now included in the roadmap:
- PostgreSQL + Prisma domain model
- catalog model vs factory instance separation
- compact/modular PLC validation
- generated PLC tags and Modbus mapping
- shared device-simulator runtime
- VFD -> motor -> process-device relationships
- live-state vs durable-history separation
- gateway command path through PLC logic
- PLC engineering print/export
- process-module composition over existing device instances
- module-specific PLC I/O allocation through normal validation
- post-MVP Go process simulation service (Phase 06, ADR-0008)
- boiler-specific thermal model isolated to Phase 07

A phase can start only when prerequisites are met. Individual task files are the execution unit.
