# TASK-402 — Three.js Factory View

Status: **READY**
Linear: [ZFA-17](https://linear.app/recruit-verse/issue/ZFA-17)

## Objective
Implement the React Three Fiber factory visualization driven by canonical Z-Factory state and reusable catalog GLB assets.

## Acceptance criteria
- Load the 3D asset referenced by each catalog model instead of hard-coding one-off meshes in the scene.
- Support PLC, VFD/drive, servo drive, soft starter, controller, motor, pump, fan/blower, conveyor, valve, sensor, switch, relay/contactor, encoder, remote I/O, gateway and future catalog categories through the same asset contract.
- Factory device instances reuse the catalog model GLB while applying their own position, rotation, scale, instance name and runtime state.
- Render connections from the same canonical relationship graph used by the 2D topology.
- Simple motion/rotation may be driven by live tags for applicable equipment without introducing a second business-state model.
- Gracefully fall back to a generic placeholder when a catalog model has no usable GLB or asset loading fails.
- 3D is visualization only and cannot become the authority for runtime/device state.
- Runtime coloring, outlines and connection-state rules are implemented by TASK-404.