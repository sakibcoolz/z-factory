# UX / Design Specification

## Core screens
1. Factories
2. Create Factory
3. Factory Designer
4. Device Catalog
5. Device Configuration
6. PLC Program
7. Runtime/Logs
8. Live Tags
9. 2D Network Topology
10. 3D Factory View

## Factory Designer
Left palette: PLC, VFD, sensor, motor, pump, gateway, switch.
Center: React Flow canvas.
Right inspector: selected device/network/configuration.
Top actions: Validate, Save, Start Factory, Stop Factory.

## PLC creation flow
Select manufacturer -> family -> exact model -> architecture branch.

### Compact
Show power, built-in DI/DO/AI/AO, communication ports, pin/channel view, tags, protocol config.

### Modular
Show CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals -> tags -> protocol config.

The form must prevent incompatible modules and invalid peripheral/channel combinations.

## Runtime state
Every device visibly shows: STOPPED, STARTING, RUNNING, DEGRADED, FAULTED, STOPPING.

## 3D
Use Three.js via React Three Fiber. 3D is visualization, not the authoritative factory model. It consumes the same device/tag state as the 2D/runtime UI.
