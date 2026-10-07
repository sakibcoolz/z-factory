# Phase 02 — OpenPLC, Docker & Device Simulation Runtime

Status: **DONE**, with runtime-lifecycle follow-ups (TASK-208 and TASK-209) open

| Task | Status |
|---|---|
| TASK-201 Docker engine integration | DONE |
| TASK-202 OpenPLC adapter | DONE |
| TASK-203 Modbus mapping & runtime ports | DONE |
| TASK-204 Device simulator runtime | DONE |
| TASK-205 Program-authoritative I/O semantics & physical target boundary | DONE |
| TASK-206 Remove a factory's Docker network and PLC containers when it is deleted (ZFA-51) | DONE |
| TASK-207 Check a factory's subnet against existing Docker networks (ZFA-52) | DONE |
| TASK-208 "Stop factory" must leave a factory stopped after a failed start (ZFA-53) | TODO |
| TASK-209 Reconcile stored runtime state with Docker after a host restart (ZFA-54) | TODO |

Exit criteria: Z-Factory can safely create an isolated factory network, run OpenPLC-backed PLC instances from reusable images, execute/version PLC programs, expose validated Modbus TCP mappings, run multiple device-simulator instances/state machines with PLC-driven feedback loops, and preserve industrial I/O semantics where the PLC scan cycle owns local outputs and external protocols target commands/setpoints rather than local output pins.
