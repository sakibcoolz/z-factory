# Phase 04 — Events, Telemetry & 3D

Status: **IN PROGRESS**

| Task | Status |
|---|---|
| TASK-401 Event stream & live telemetry | DONE |
| TASK-402 Three.js factory view | DONE |
| TASK-403 Meshy MCP catalog 3D asset generation | PLANNED |
| TASK-404 Live 3D runtime-state visualization | DONE |

## Scope
Phase 04 provides live events/telemetry plus a reusable 3D representation for the generic hardware catalog.

The 3D pipeline is catalog-first:

```text
Catalog model
  -> Meshy MCP generation
  -> normalized/versioned GLB
  -> Z-Factory asset storage
  -> reusable catalog 3D asset
  -> factory device instance
  -> Three.js / React Three Fiber view
```

Rules:
- PLCs, VFDs/drives, servo drives, soft starters, controllers, motors, pumps, fans/blowers, conveyors, valves, sensors, switches, relays/contactors, encoders, remote I/O, gateways and future catalog peripherals use the same reusable 3D asset contract.
- Meshy is used to author or regenerate catalog assets, not on every runtime render.
- Generated GLB files are stored in the project-controlled asset structure and reused by all instances of that catalog model.
- Live telemetry changes visual state only; it never regenerates the GLB.
- RUNNING devices receive a green visual emphasis/outline.
- FAULTED devices receive a red visual emphasis/outline.
- Connections associated with a faulted device are rendered red; healthy active connections may be green/animated.
- 3D consumes the same canonical device, connection and runtime state as topology/live tags and is never a separate source of truth.
- Process/module-specific 3D authoring is out of scope for Phase 04 and will be designed separately when module creation UX is defined.

Exit criteria: the UI receives live PLC/device state, command/feedback changes, alarms/faults and selected telemetry; PostgreSQL persists durable history without becoming the live-state authority; topology and 3D consume the same canonical runtime state; reusable catalog GLB assets exist or have a graceful fallback; live RUNNING/FAULTED state is visible on catalog device instances and their affected connections.