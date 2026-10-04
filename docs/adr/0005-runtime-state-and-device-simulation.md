# ADR 0005 — Runtime State and Device Simulation

Status: Accepted — 2026-10-04

## Decision
OpenPLC and device-simulator memory are authoritative for live values. PostgreSQL persists durable configuration, important snapshots, commands, alarms/events/audit history and selected telemetry.

Ordinary VFDs, motors, pumps, valves, sensors and switches use a shared device-simulator runtime with factory-specific instances. One container per simple peripheral is not the MVP default.

MVP VFD relation is one VFD instance to one primary motor.

## Consequences
- UI live values come from runtime/event streams, not database polling as the control truth.
- High-frequency ticks are not blindly persisted.
- Simulator state machines must be deterministic/testable where practical.
- Later high-fidelity/dedicated simulators can be introduced behind runtime adapters.
