# TASK-405 — 3D Physical Conductor Rendering

Status: **PLANNED**
Linear: [ZFA-36](https://linear.app/recruit-verse/issue/ZFA-36)

## Objective
Render physical conductors in the 3D factory view from the canonical pin-to-pin wiring produced by TASK-307.

## User stories
- As a user, I see one clean logical connection in 2D but the actual individual conductors in 3D.
- As an engineer, I can visually understand which physical wires run between two catalog devices.
- As a user, I see runtime/fault state applied consistently to the physical conductors.

## Rendering rules
- 2D topology remains one logical edge between devices.
- 3D expands that logical edge into the physical conductor set defined by endpoint wiring metadata.
- Example: a three-phase VFD-to-motor power connection renders three thin conductors (for example L1/L2/L3 or U/V/W as defined by the catalog data), not one thick logical line.
- The same behavior applies to every supported catalog connection: PLC I/O, sensors, valves, relays/contactors, drives, motors, encoders, remote I/O, controllers, gateways and future catalog peripherals.
- Conductor count and labels come from persisted wiring; the renderer must not guess missing wires.
- Signal, feedback, power, common/ground, earth/shield and bus conductors are rendered only when explicitly modeled.
- Multiple wires sharing an allowed power/common/bus endpoint remain distinct conductor records.

## Runtime state
- Healthy active conductors may use the existing running/active visual semantics.
- A fault affecting a device or connection marks the affected conductor set red.
- Stale/disconnected semantics follow TASK-404.
- GLB assets are not regenerated to reflect wiring or state.

## Acceptance criteria
- A logical edge with N persisted conductors renders N thin 3D lines.
- VFD-to-motor three-phase wiring renders three distinct lines when three conductors are present.
- All catalog device combinations use the same generic conductor renderer.
- No physical wire is invented from device type alone.
- 3D reads TASK-307 canonical wiring and never owns a separate wiring map.
