# TASK-401 — Events & Live Telemetry

Status: **PLANNED**
Linear: pending

## Objective
Implement internal domain/runtime events, selected event persistence, and live browser delivery.

## Acceptance criteria
- Versioned event envelope.
- SSE as initial server-to-browser transport.
- Reconnect/last-event strategy.
- Lifecycle/fault/audit events persisted.
- High-frequency telemetry retention strategy.
- Tests for event ordering/state transitions where relevant.
