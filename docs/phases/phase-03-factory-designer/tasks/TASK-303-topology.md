# TASK-303 — React Flow Factory Topology

Status: **DONE**
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

## Evidence (2026-10-05)
- **Drag/drop catalog-backed device instances.** The palette lists every catalog model; a drop (or the "+" button) creates an instance at that position. A PLC placed on the canvas has its I/O points or rack.
- **Unique instance names on the canvas.** New devices get the next free numbered name; a duplicate name is refused; devices can be renamed in the inspector.
- **Save and load positions and connections.** Positions are stored on drag end (`DeviceInstance.canvasX/Y`); a reload shows the same canvas.
- **Typed edges** for `CONTROLS`, `DRIVES`, `MECHANICALLY_DRIVES`, `MEASURES`, `FEEDS_BACK_TO` and `COMMUNICATES_WITH`, each stored in its own direction whichever way it was drawn.
- **Validation uses available PLC endpoints.** Wiring to a PLC takes free compatible channels and creates tags; with no free or no compatible channel the connection is refused and nothing is created.
- **Invalid or occupied endpoints cannot be connected.** Also refused: a second motor on a drive, a relationship that does not exist between two devices, two PLCs, a duplicate.
- **Runtime-state overlay.** Node state, active and fault colouring of edges, faulted count in the status bar.
- **Z-Factory ids only.** The topology view is checked to carry no Docker id.
- Tests: 7 link-rule tests, 14 component tests (palette, inspector, canvas), 10 service tests against PostgreSQL. 459 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.
- Real browser: in headless Chrome against a production build, devices were added from the palette, nodes dragged, an allowed connection drawn (typed edges appeared, three channels occupied), a refused one drawn (reason shown, nothing created), and the page reloaded with positions and edges intact.

## Decisions made in this task
- **Dependency:** React Flow 12 (`@xyflow/react`, MIT), as the task names it.
- **Positions** are two nullable columns on `DeviceInstance` (migration `device_canvas_position`).
- **The relationship is derived**, not picked from a list of six; the user is asked only when several apply.
- **A device is wired to a PLC as a whole** from the canvas: all its terminals, automatically assigned. Choosing individual channels stays on the PLC's Connections screen.
- **Every change is saved when made**; there is no draft or Save button.

## Not in this task
- The overlay shows the stored runtime state and reloads every 5 seconds while something runs; a live stream is TASK-401.
- Start/Stop factory and Export from the designer toolbar (TASK-305, TASK-304).
- Zones, layers, edge routing, undo, multi-select operations and search in the palette.
- Dragging from the palette was verified by component test and by its "+" button in the browser; a native drag gesture was not automated.
