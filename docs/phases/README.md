# Development Phases

| Phase | Name | Status | Gate |
|---|---|---|---|
| 00 | Documentation & Foundation | IN PROGRESS | Docs approved, repo bootstrap plan ready, Linear team chosen |
| 01 | Core Next.js Platform | PLANNED | Phase 00 Done |
| 02 | OpenPLC, Docker & Device Simulation Runtime | PLANNED | Phase 01 Done |
| 03 | Factory Designer, Device Modeling & PLC Export | PLANNED | Phase 02 core runtime usable |
| 04 | Events, Telemetry & 3D | PLANNED | Factory topology/runtime stable |
| 05 | External Gateway MVP | PLANNED | Modbus runtime externally reachable |

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

A phase can start only when prerequisites are met. Individual task files are the execution unit.
