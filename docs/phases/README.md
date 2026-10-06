# Development Phases

| Phase | Name | Status | Gate |
|---|---|---|---|
| 00 | Documentation & Foundation | DONE | Docs approved, repo bootstrap plan ready, Linear team chosen |
| 01 | Core Next.js Platform | DONE | Phase 00 Done |
| 02 | OpenPLC, Docker & Device Simulation Runtime | DONE | Phase 01 Done |
| 03 | Factory Designer, Device Modeling & PLC Export | DONE | Phase 02 core runtime usable |
| 04 | Events, Telemetry & 3D | DONE | Factory topology/runtime stable |
| 05 | External Gateway MVP | DONE | Modbus runtime externally reachable |
| 06 | Process Module Framework & Go Simulation Service | IN PROGRESS | Phase 02–05 foundations stable; ADR-0008 |
| 07 | PLC-to-PLC Communication | PLANNED | Multi-PLC OpenPLC runtime + Modbus mapping stable |
| 08 | Simulation Control, Overrides & Closed-Loop Testing | PLANNED | Go simulation + PLC bridge stable; ADR-0015 |
| 09 | MVP 2 — Production Edge & Cloud Integration | PLANNED | Thin Client Agent + closed-loop test foundations ready |

Cross-cutting requirements now included in the roadmap:
- PostgreSQL + Prisma domain model
- catalog model vs factory instance separation
- compact/modular PLC validation
- generated PLC tags and Modbus mapping
- shared device-simulator runtime
- VFD -> motor -> process-device relationships
- intermediate/control-interface device chains without forcing an intermediate device
- live-state vs durable-history separation
- gateway command path through PLC logic
- PLC engineering print/export
- process-module composition over existing device instances
- module-specific logical signal contracts
- authoritative module PLC I/O registry and consumed-I/O summary
- module I/O allocation through normal PLC tag/channel/register validation
- post-MVP Go process simulation service (Phase 06, ADR-0008)
- PLC-to-PLC communication with explicit Modbus TCP client/server mappings
- independent PLC containers/programs with validated inter-PLC data exchange

Phase 06 execution units:
- TASK-601 Process module domain & persistence
- TASK-602 Go simulation service foundation
- TASK-603 Simulator/Modbus closed-loop bridge
- TASK-604 Process module designer & validation
- TASK-605 Module PLC I/O registry & allocation

Phase 07 execution units:
- TASK-701 PLC relationship & communication domain
- TASK-702 Modbus TCP client/server mapping
- TASK-703 PLC-to-PLC runtime adapter & Docker networking
- TASK-704 PLC-to-PLC UI, validation & E2E tests

Phase 08 execution units:
- TASK-801 Simulation override runtime contract & Go API
- TASK-802 Simulation override UI & operator controls
- TASK-803 PLC output -> simulator command bridge
- TASK-804 Closed-loop scenarios, events & E2E validation

Phase 09 is the **MVP 2** delivery boundary for production edge and cloud integration. Detailed TASK-9xx execution units will be added before implementation starts. Its primary dependency is TASK-503 (Z-Factory Thin Client Agent), plus the Phase 08 closed-loop validation foundation.

A phase can start only when prerequisites are met. Individual task files are the execution unit.
