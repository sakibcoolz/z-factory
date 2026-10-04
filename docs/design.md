# UX / Design Specification

## Core screens
1. Factories
2. Create Factory
3. Factory Designer
4. Device Catalog
5. Device Configuration
6. PLC Details / Edit PLC
7. PLC Program & Versions
8. PLC I/O Mapping / Pinout
9. Simulator / Debug
10. Live Tags
11. Events / Alarms / Logs
12. Runtime / Containers
13. 2D Network / Wiring Topology
14. PLC Export / Print
15. 3D Factory View

## Factory Designer
Left palette: PLC, VFD/drive, motor, pump, fan/blower, conveyor, valve, sensor, switch, relay/contactor, encoder, remote I/O, gateway.

Center: React Flow canvas.

Right inspector: selected device model, factory instance name/role, runtime state, connections, channel/tag/register mapping.

Top actions: Validate, Save, Start Factory, Stop Factory, Export.

## Device creation
User chooses reusable catalog model then creates a factory-specific instance with a unique name such as `VFD-01`, `MOTOR-01`, `PUMP-01`, `PT-101`, `LS-101`.

The UI should show only compatible and unoccupied PLC channels/protocol endpoints.

## PLC creation flow
Select manufacturer -> family -> exact model -> architecture -> role/name -> compatible peripherals -> I/O/tag/protocol mapping -> runtime config.

### Compact
Show power, built-in DI/DO/AI/AO, communication ports, visual pin/channel view, occupancy, tags, protocol config, connected devices.

### Modular
Show CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals -> occupancy -> tags -> connected devices.

The form must prevent incompatible modules, duplicate channel use, invalid signal types, and unsupported peripheral/channel combinations.

## PLC edit
Tabs/sections:
Overview, Hardware/Pinout, Rack & Modules, Connections, Program, I/O Mapping, Simulator, Live Tags, Events, Logs, Versions, Runtime, Export.

## Device simulation UI
Show command/setpoint and actual feedback separately.

Examples:
- VFD: Run command, frequency setpoint, actual frequency, current, torque, status, fault.
- Motor: commanded/actual RPM, current, torque, temperature, status.
- Pump: run status, flow, pressure, fault.
- Valve: open/close/position command, actual position, end-switch feedback, fault.
- Sensor: current process value, unit, quality, simulated source/profile.

## Runtime state
Every device visibly shows: STOPPED, STARTING, RUNNING, DEGRADED, FAULTED, STOPPING, DISCONNECTED where applicable.

## Export
PLC details page exposes Print / Export:
- PDF-oriented engineering report
- CSV I/O/tag schedules
- JSON machine-readable configuration
- complete configuration package for reproducibility/import

## 3D
Three.js via React Three Fiber. 3D is visualization, not the authoritative factory model. It consumes the same canonical runtime/device/tag state as topology and live-tag views.
