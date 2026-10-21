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
| 09 | MVP 2 — Production Edge & Cloud Integration | IN PROGRESS | Thin Client Agent + closed-loop test foundations ready |\n| 10 | Agent-Ready Engineering & Full Catalog Go Simulation | IN PROGRESS | Active engineering model + catalog/runtime foundations stable |
| 11 | Multi-Protocol PLC Connectivity (Modbus TCP + OPC UA) | PLANNED | Thin Client + PLC mapping/export foundations stable |
| 12 | Functional Safety Engineering & Verification | PLANNED | Review existing safety-related capabilities and reconcile roadmap statuses |

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
- production Go Thin Client Agent with dynamic file-driven PLC workers
- secure MQTT edge-to-cloud transport
- Web Factory TypeScript cloud application for monitoring, history and remote command orchestration\n- browser-agent-readable LLM Index and page-level LLM Context, without embedded LLM/MCP dependency\n- catalog-driven Go device behavior simulation with explicit fidelity/coverage

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

Phase 09 execution units:
- TASK-901 Web Factory TypeScript Cloud Foundation & Identity Model
- TASK-902 MQTT Broker Integration, Agent Onboarding & Connectivity
- TASK-903 Telemetry Ingestion, Cloud Persistence & Latest-State Projection
- TASK-904 Web Factory Live Monitoring, Dashboards, Events & Alarms
- TASK-905 Remote Command/Setpoint Lifecycle, Authorization & Audit
- TASK-906 Production Edge Deployment, Resilience, Security & Physical E2E

Phase 09 is the **MVP 2** delivery boundary. TASK-503 (Z-Factory Thin Client Agent) remains its primary edge-agent dependency, with Phase 08 providing closed-loop validation foundations.

A phase can start only when prerequisites are met. Individual task files are the execution unit.


Phase 10 execution units:
- TASK-1001 Global LLM Index & complete agent guide
- TASK-1002 Reusable page-level LLM Context framework
- TASK-1003 LLM Context tabs across active engineering pages
- TASK-1004 Agent navigation index and cross-page guidance
- TASK-1005 Sidebar cleanup and active-feature navigation
- TASK-1006 User-decision and recommendation guidance
- TASK-1007 Agent-readable validation and error explanations
- TASK-1008 Browser-agent end-to-end engineering validation
- TASK-1009 Go Catalog Simulation Runtime foundation
- TASK-1010 Catalog device capability and behavior schema
- TASK-1011 Full industrial device behavior library
- TASK-1012 Vendor catalog model to simulation-profile mapping
- TASK-1013 Protocol/register-controlled device simulation
- TASK-1014 Fault, failure and degraded-quality simulation
- TASK-1015 Dynamic catalog-driven simulator instantiation
- TASK-1016 Catalog simulation coverage report and validation


Phase 11 execution units:
- TASK-1101 PLC protocol capability & per-instance selection
- TASK-1102 Versioned multi-protocol Edge Deployment JSON contract
- TASK-1103 Thin Client protocol-adapter interface & normalized tag model
- TASK-1104 OPC UA client/session/subscription runtime
- TASK-1105 Mixed Modbus + OPC UA worker orchestration
- TASK-1106 Multi-protocol command/write lifecycle & safety
- TASK-1107 UI, observability, migration & mixed-protocol E2E validation
- TASK-1108 Expose Factory & factory-level Edge Deployment JSON generation


Phase 12 execution units:
- [TASK-1201](./phase-12-functional-safety-engineering/tasks/TASK-1201.md)
- [TASK-1202](./phase-12-functional-safety-engineering/tasks/TASK-1202.md)
- [TASK-1203](./phase-12-functional-safety-engineering/tasks/TASK-1203.md)
- [TASK-1204](./phase-12-functional-safety-engineering/tasks/TASK-1204.md)
- [TASK-1205](./phase-12-functional-safety-engineering/tasks/TASK-1205.md)
- [TASK-1206](./phase-12-functional-safety-engineering/tasks/TASK-1206.md)
- [TASK-1207](./phase-12-functional-safety-engineering/tasks/TASK-1207.md)
- [TASK-1208](./phase-12-functional-safety-engineering/tasks/TASK-1208.md)
- [TASK-1209](./phase-12-functional-safety-engineering/tasks/TASK-1209.md)
- [TASK-1210](./phase-12-functional-safety-engineering/tasks/TASK-1210.md)

See [Phase 12 plan](./phase-12-functional-safety-engineering/README.md). This is simulator engineering and assessment preparation, **not a claim of SIL/PL achievement or certification**.
