# TASK-303 — React Flow Factory Topology

Status: **PLANNED**
Linear: [ZFA-14](https://linear.app/recruit-verse/issue/ZFA-14)

## Objective
Implement visual factory-specific device placement and typed connection editing with React Flow.

## Acceptance criteria
- Drag/drop catalog-backed factory device instances.
- Unique instance names visible on canvas.
- Save/load node positions and connections.
- Typed edges represent CONTROLS, DRIVES, MECHANICALLY_DRIVES, MEASURES, FEEDS_BACK_TO and COMMUNICATES_WITH relationships.
- Connection validation uses available PLC I/O/protocol endpoints.
- Invalid/occupied endpoints cannot be connected.
- Runtime-state/activity/fault overlay.
- UI nodes reference Z-Factory IDs, never raw Docker IDs.
