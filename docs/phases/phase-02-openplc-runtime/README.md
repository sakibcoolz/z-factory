# Phase 02 — OpenPLC, Docker & Device Simulation Runtime

Status: **IN PROGRESS**

| Task | Status |
|---|---|
| TASK-201 Docker engine integration | DONE |
| TASK-202 OpenPLC adapter | DONE |
| TASK-203 Modbus mapping & runtime ports | DONE |
| TASK-204 Device simulator runtime | DONE |
| TASK-205 Program-authoritative I/O semantics & physical target boundary | PLANNED |

Exit criteria: Z-Factory can safely create an isolated factory network, run OpenPLC-backed PLC instances from reusable images, execute/version PLC programs, expose validated Modbus TCP mappings, run multiple device-simulator instances/state machines with PLC-driven feedback loops, and preserve industrial I/O semantics where the PLC scan cycle owns local outputs and external protocols target commands/setpoints rather than local output pins.
