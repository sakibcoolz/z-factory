# TASK-602 — Go Simulation Service Foundation

Status: **PLANNED**

## Goal
Implement the ADR-0008 Go service as an additive advanced-process runtime.

## Scope
- standalone Go service/container
- deterministic configurable simulation clock/tick
- per-factory/per-module in-memory state
- common simulator/model interface
- lifecycle: load, start, pause/stop, reset, inspect, health
- versioned configuration contract from Z-Factory
- resource limits and isolation policy
- structured logs, health and basic metrics
- unit/integration test harness

## Invariants
- Do not replace the Phase 02 shared device simulator.
- PLC remains the control authority.
- Do not persist every tick to PostgreSQL.
- One process model may host many module/device states; do not create one container per simple sensor/valve/motor.
- Determinism must be testable with fixed configuration, inputs and time steps.

## Acceptance
- Service runs a deterministic tick loop for multiple independent module instances.
- It can load versioned module/model configuration and report health/state.
- Restart/reset behavior is defined and tested.
- No direct browser-to-simulation privileged control path exists.
