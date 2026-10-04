# ADR 0008 — Post-MVP Go Process Simulation Service

Status: Accepted — 2026-10-05

## Context
The MVP architecture is intentionally one Next.js TypeScript application with a shared device-simulator runtime. Advanced process simulation introduces long-running tick loops, coupled process models, many concurrent simulated instances, and future models such as boiler thermal zones.

Adding that complexity directly to the current Phase 02 runtime would expand its scope and risk destabilizing the existing PLC/container roadmap.

## Decision
Keep Phases 02–05 on the existing Next.js/OpenPLC/shared-device-simulator architecture.

Introduce a separate Go simulation service only in Phase 06 or later for advanced process modules and coupled process simulation.

The Go service:
- runs deterministic tick-based process/device models;
- hosts many factory/module instances rather than one container per simple device;
- receives validated configuration from Z-Factory;
- exchanges commands and feedback through approved runtime/protocol adapters, with Modbus TCP as the first bridge;
- keeps live process state in memory and emits meaningful events/selected snapshots;
- never becomes the PLC control authority.

The PLC remains responsible for control logic, interlocks, PID decisions and output commands. The simulator computes the process response to those outputs and returns sensor/process feedback.

## Compatibility rule
The Go service is additive. It must not require Phase 02–05 database/runtime contracts to be rewritten. Integration occurs behind explicit adapters and versioned contracts.

## Process-module rule
Generic PLCs, sensors, drives, motors, valves and other devices remain catalog/device instances. Process modules compose those existing instances and allocate logical PLC I/O. Boiler-specific physics and I/O stay in the boiler module rather than the generic device catalog.

## Consequences
- ADR-0001 remains authoritative for the MVP.
- Coding agents must not introduce the Go service before Phase 06 is active.
- Phase 06 must define service API/config/event contracts and integration tests before relying on it.
- High-frequency ticks remain in runtime memory; PostgreSQL stores durable configuration, important snapshots, events/alarms and selected telemetry.
- Simulation fidelity must be documented and must not be presented as engineering certification.
