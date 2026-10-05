# TASK-404 — Live 3D Runtime-State Visualization

Status: **PLANNED**

## Objective
Map canonical live runtime state and telemetry onto the reusable catalog 3D scene without changing the underlying GLB asset.

## State rules
- RUNNING: green outline/emphasis around the device.
- FAULTED: red outline/emphasis around the device.
- DEGRADED or stale: warning treatment consistent with Z-Factory design tokens.
- DISCONNECTED: disconnected/external treatment consistent with Z-Factory design tokens.
- STOPPED/STARTING/STOPPING: distinct non-fault states without misrepresenting them as running or faulted.

## Connection rules
- A connection whose endpoint is FAULTED is rendered red.
- A healthy active connection may be green and/or animated.
- Connection visuals derive from canonical relationship + runtime state; the 3D view does not invent connectivity.
- When status changes, device and related connection visuals update from the event/telemetry stream without regenerating the model.

## Acceptance criteria
- Consume TASK-401 live events/telemetry and the same canonical state used by topology/live tags.
- Apply runtime appearance as renderer overlays/material/outline effects rather than modifying the stored GLB.
- A device state transition is reflected in the 3D scene without page-level business-state duplication.
- FAULTED devices and their affected connections are visually obvious in red.
- RUNNING devices are visually obvious in green.
- Existing design-system fault/running/degraded/disconnected semantics remain consistent between 2D and 3D views.
- Motion/animation, when present, stops or changes appropriately on fault/disconnect.
- Missing telemetry degrades gracefully and never shows a false healthy state.