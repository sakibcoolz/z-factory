# TASK-704 — PLC-to-PLC UI, Validation & E2E Tests

Status: **PLANNED**

## Goal
Expose PLC-to-PLC relationships and mappings in Z-Factory and prove the full communication path end to end.

## Scope
- PLC communication tab/section
- select source and target PLC
- select protocol and client/server role
- mapping table for local tag <-> remote register/tag
- READ/WRITE direction
- polling interval
- connection health
- stale/disconnected/error state
- validation summary
- topology edge between PLCs
- engineering export
- end-to-end scenarios

## Required E2E scenarios
1. PLC-A reads a status/feedback value from PLC-B.
2. PLC-A writes a permitted command/setpoint to PLC-B.
3. PLC-B local logic reacts to that command.
4. Invalid write to read-only feedback is rejected.
5. Target PLC disconnect produces stale/disconnected state.
6. Target PLC restart reconnects without rebuilding either image.
7. Cross-factory PLC relationship is rejected.

## Acceptance
- User can visually trace PLC-A tag -> communication mapping -> PLC-B register/tag.
- Connection and quality state are visible.
- Export includes source/target PLC, protocol, endpoint, mapping, direction and timing.
- E2E tests prove that two independent PLC programs remain isolated while exchanging configured data.
