# Product Definition

## Name
Z-Factory

## Goal
Create a browser-first virtual industrial factory where users can build realistic PLC-controlled systems, execute PLC programs, connect industrial peripherals, simulate closed-loop behavior, inspect live state/faults, integrate an external edge gateway, and export an engineering snapshot of each PLC.

## MVP capabilities
- Factory CRUD and isolated factory runtime lifecycle.
- PostgreSQL + Prisma persistence.
- Catalog-backed PLCs and industrial peripherals.
- Compact and modular PLC modeling.
- Factory-specific uniquely named device instances.
- I/O pin/channel, tag, and Modbus-address assignment with compatibility validation.
- OpenPLC program editing/versioning, compile/deploy/run/stop/restart/debug workflow.
- Reusable OpenPLC Docker runtime image with generated per-PLC configuration.
- Modbus TCP command/setpoint and feedback/status mappings.
- Shared device simulation for sensors, switches, valves, VFDs, motors, pumps, fans, conveyors and related equipment.
- Real-time state, faults, alarms, events and selected telemetry.
- React Flow factory topology/wiring view.
- External industrial edge/gateway access through validated host endpoints.
- PLC engineering export/print including I/O, tags, connected devices, topology and versions.
- Three.js/React Three Fiber visualization later in the roadmap.

## Device/control model
A typical loop is:

```text
Sensor -> PLC input/tag -> PLC logic -> VFD/Valve/Output
       -> Motor/Pump/Process -> feedback sensor/tag -> PLC
```

Remote command path:

```text
Cloud/UI -> Edge Gateway -> Modbus TCP -> PLC command tag
         -> PLC logic -> VFD/Motor/Pump/Valve
```

## Post-MVP process-module roadmap
After the MVP, Phase 06 introduces reusable process modules and an optional Go process-simulation service. Phase 07 introduces PLC-to-PLC communication over Modbus TCP. These phases reuse the existing PLC/device catalog, I/O/tag mapping, Docker networking and Modbus control boundary rather than changing the MVP foundation.

A process module can group existing devices, declare module-specific PLC inputs/outputs, and run a coupled deterministic process model. Phase 07 additionally allows independent PLC programs/containers to exchange explicitly mapped status, process, command and setpoint data while each target PLC retains its own local control logic.

## Explicitly out of MVP
- Exact Siemens/Rockwell/Schneider firmware emulation.
- TIA Portal or Studio 5000 compatibility.
- Timing-accurate PROFINET/EtherCAT simulation.
- Full electrical/mechanical/fluid/process-design physics or certification. Post-MVP models remain explicit approximations for software/control testing.
- Safety-rated control simulation or certification.
- Arbitrary host command execution from the browser.

## Primary demo
Pressure/level sensor -> OpenPLC -> VFD -> motor -> pump/process -> feedback, with an external industrial gateway reading feedback and writing command/setpoint registers while Z-Factory shows the complete loop live.
