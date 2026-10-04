# Process Modules

## Purpose
Process modules group reusable industrial devices into a process-specific unit without redefining the underlying PLC, sensor, actuator, drive, controller or interface-device catalog.

Examples: machine cell, pump house, tank farm, conveyor cell, HVAC loop, mixer, compressor skid.

A process module is configuration and simulation composition, not a new hardware catalog.

## Separation of concerns
- `DeviceModel` / `DeviceInstance`: reusable hardware facts and factory-specific physical/logical device instances.
- `ProcessModuleType`: reusable process template and its expected roles/I/O contract.
- `ProcessModuleInstance`: one factory-specific use of that process module.
- `ModuleDevice`: assigns existing factory device instances to roles inside the module.
- `ModuleSignalDefinition`: declares the reusable logical signal contract.
- `ModulePlcIoMapping`: binds one module signal to existing PLC tags/I/O/protocol mappings.
- `ModuleInterlock`: module-specific control/safety-condition metadata used for validation, simulation, documentation and testing.

A process module must never duplicate or override authoritative vendor hardware facts from the device catalog.

## Module I/O contract
Each module declares logical signals before they are bound to a concrete PLC.

Signal directions are from the PLC/control-program perspective:
- `INPUT`: value read by PLC logic, such as temperature, pressure, level, switch state, drive feedback.
- `OUTPUT`: command produced by PLC logic, such as heater enable, valve command, VFD setpoint, motor starter command.
- `INTERNAL`: calculated/runtime-only process value not directly wired to physical I/O.
- `ALARM`: module alarm/status point.

Each logical signal defines:
- stable key/name
- direction
- data type
- engineering unit
- expected signal/protocol class
- required/optional status
- semantic role
- compatible device role/category
- optional scaling/range
- description

## Module PLC I/O Registry
Every `ProcessModuleInstance` has an authoritative consumed-I/O registry built from its signal definitions and bindings.

The registry answers:
- which PLC inputs the module consumes
- which PLC outputs the module consumes
- which signals are required or optional
- which PLC/tag/I/O/register each signal is bound to
- current validation/quality state

The I/O count is not globally fixed. Different machine/module profiles can require different numbers of sensors, feedback points, commands, setpoints, valves, drives or controller signals.

Example:

```text
MACHINE-CELL-01
  INPUT  TEMP_PROCESS     -> PLC-01 / TT_PROCESS / Input Register
  INPUT  DRIVE_READY      -> PLC-01 / DRIVE_READY / Discrete Input
  INPUT  POSITION_ACTUAL  -> PLC-01 / POS_ACTUAL / Input Register
  OUTPUT RUN_CMD          -> PLC-01 / RUN_CMD / Coil
  OUTPUT SPEED_SETPOINT   -> PLC-01 / SPEED_SP / Holding Register
```

Binding a module to a PLC must reuse normal Z-Factory I/O/tag validation. A module does not bypass PLC channel occupancy, signal compatibility, register overlap, access-mode or same-factory rules.

Required unmapped signals make the module not ready to run. Optional unmapped signals are allowed.

## Device assignment
A module role points to an existing `DeviceInstance`.

Example roles for a machine module:
- process sensor
- drive/controller
- motor/actuator
- valve
- feedback sensor
- safety/status input metadata

The role describes process meaning. The device instance still owns manufacturer/model/runtime identity.

## Intermediate devices
A module may contain direct PLC I/O or chains through intermediate/control-interface devices.

Examples:
- `PLC -> VFD -> Motor -> Pump`
- `PLC -> Servo Drive -> Servo Motor`
- `PLC -> Remote I/O -> Sensors / Valves`
- `PLC -> Temperature Controller -> Heater`

The framework must not force an intermediate device where the physical/logical topology does not require one.

## Simulation boundary
Simple device behavior remains in the generic device simulator.

A process model may couple multiple devices and process values, for example:
`drive setpoint -> motor behavior -> process value -> virtual/assigned sensor -> PLC input`.

The simulator computes process response; the PLC remains the control authority and decides commands/setpoints.

## PLC feedback loop
Canonical closed loop:

```text
Process/device simulator
  -> feedback/process-value mapping
  -> PLC input/tag
  -> PLC program/interlocks/PID
  -> PLC command/setpoint tag
  -> process/device simulator
```

Modbus TCP remains the first protocol bridge. Simulator-produced numeric values may be exposed through Input Registers or other validated mappings; PLC commands use writable Coils/Holding Registers according to existing tag rules.

## Runtime strategy
Phases 02–05 keep the MVP shared simulator inside the current architecture.

Phase 06 introduces an optional dedicated Go simulation service for advanced coupled process simulation under ADR-0008. It is not a prerequisite for the MVP runtime and must not force rewrites of completed phases.

## Fidelity
Process models are deterministic software/control-test approximations unless explicitly documented otherwise. They are not process-design, mechanical, electrical, thermodynamic, or safety certification.
