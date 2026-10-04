# TASK-401 — Events & Live Telemetry

Status: **PLANNED**
Linear: [ZFA-16](https://linear.app/recruit-verse/issue/ZFA-16)

## Objective
Implement internal domain/runtime events, selected persistence, alarms and live browser delivery without making PostgreSQL the live-state authority.

## Acceptance criteria
- Versioned event envelope.
- SSE as initial server-to-browser transport.
- Reconnect/last-event strategy.
- PLC tag, VFD, motor, pump, valve, sensor, gateway and fault events supported.
- Live values include quality and timestamp.
- Lifecycle/command/fault/alarm/audit events persisted.
- High-frequency telemetry uses sampling/change-threshold/retention strategy.
- DeviceRuntimeSnapshot is treated as snapshot, not control truth.
- Tests cover event ordering and important state transitions.
