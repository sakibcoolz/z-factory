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

## Implementation (TASK-601, TASK-605)
The domain and its persistence exist, with the PLC I/O registry (TASK-605), the process runtime (TASK-602, TASK-603; docs/process-simulation.md) and the screens (TASK-604; docs/design.md → Process modules as built).

```text
lib/domain/process-module.ts        pure rules: directions, profiles, configuration, roles, interlocks, issues
lib/domain/process-bridge.ts        pure rules: which tag may carry which signal (shared with the bridge)
lib/domain/module-io-view.ts        the registry's shapes; builds rows, counts and per-PLC use from stored bindings
lib/process-modules/schema.ts       shape and rules of a type definition (parseModuleType)
lib/process-modules/types.ts        the shipped types
lib/process-modules/ingest.ts       writes type versions (npm run db:seed)
lib/services/process-module-service.ts   types, module instances, device roles, interlocks
lib/services/module-io-service.ts        the registry: bind, rebind, release, candidates, summary, export/import
lib/services/module-designer-service.ts  what the screens show, composed from the above and the running bridge
components/modules/                      list, new-module form, editor, pickers, topology
```

### Module types
A type is data: a definition checked by `parseModuleType` and stored as a version. Types are reference data of the installation, like the catalog, and are not owned by a factory. A stored version is never changed; a changed template is published as a new version, and modules created from the old one keep it.

A definition holds:
- **profiles**: selectable variants. A role or signal that names profiles exists in those only; one that names none exists in all. This is how one type has different I/O counts.
- **roles**: key, name, the device categories that can fill it, required or optional, how many devices it takes.
- **signals**: the logical I/O contract described above. An `OUTPUT` is a command or a setpoint and nothing else is, so the PLC stays the only source of commands; an `ALARM` point is an alarm or a status. A signal may belong to a role; a required signal cannot belong to an optional role.
- **configuration fields**: the settings an instance may carry (number, whole number, switch, text, choice; limits, unit, default). Process-specific settings exist only here.

Shipped types (generic templates; they name device categories, never a manufacturer or model):

| Type | Profiles | Roles | Signals of the largest profile |
|---|---|---|---|
| `PUMP_HOUSE` v1 | `SINGLE_PUMP`, `DUTY_STANDBY` | duty pump, duty drive or starter (optional), standby pump and drive (`DUTY_STANDBY`), discharge pressure transmitter, suction level switch (optional), discharge valve (optional) | 7 inputs (3 required), 5 outputs (2 required), 1 internal, 2 alarms |
| `TANK` v1 | `LEVEL`, `LEVEL_TEMPERATURE` | level transmitter, inlet valve, outlet valve (optional), high-level switch (optional), temperature transmitter (`LEVEL_TEMPERATURE`), agitator (optional) | 6 inputs (2 required), 3 outputs (1 required), 1 internal, 2 alarms |

Both are simulated by the process model of the same name (`simulatorModelType`); their configuration fields are the model's parameters.

### Module instances
- A module belongs to one factory and is named like a device (`PUMP-HOUSE-01`); the name is unique within the factory. A factory of another owner, and everything in it, does not exist for the caller.
- It takes one profile of its type (the first when none is asked for) and a configuration checked against the type's fields and filled with their defaults. A setting the type does not declare is refused.
- Changing the profile is refused while the module holds a device or an interlock the new profile has no place for. Nothing is unassigned as a side effect.
- Deleting a module removes its role assignments and interlocks. Its devices stay in the factory, unchanged.

### Devices in roles
- A role is filled with an existing device of the **same factory**. A device of another factory of the same owner is rejected (`module-device-factory`); a device of another owner is not found.
- The device's category has to be one the role accepts (`module-role-category`), the role has to exist in the module's profile (`module-role-profile`) and have a free place (`module-role-full`). Two assignments made at the same time cannot both take a role's last place: the module's row is locked while the place is counted.
- The assignment changes nothing on the device: not its model, its wiring or its tags. A device may have roles in several modules, and more than one role in a module.
- Deleting a device removes its assignments; the module then reports the role as empty.

### Interlocks
An interlock is metadata of a module instance: while every condition in `when` holds, the outputs in `blocks` are expected to be held off. A BOOL signal is read with `IS_TRUE` / `IS_FALSE`; a number is compared with a value inside the signal's range; `blocks` names `OUTPUT` signals of the module's profile. An interlock that names a signal the module does not have is refused. It documents and tests the control program. It does not act on the PLC, and it is never a safety function.

### What a module reports
`getModule` returns the roles and signals of the selected profile, the devices in each role, the interlocks, signal counts per direction (required and optional) and the issues that keep the module from being complete: a required role without a device, a role with too many devices, a device whose category or profile no longer fits, an enabled interlock that no longer fits. `complete` covers roles and interlocks only. `bindings` counts the module's PLC bindings (accepted, invalid, required signals without one) and `readyToRun` says whether the module is complete, every required signal is bound to an accepted tag and its type names a process model.

### The PLC I/O registry (TASK-605)
A module's signal is bound to one tag of one PLC of the same factory (`ModulePlcIoMapping`). Changing the profile is refused while a binding's signal has no place in the new profile; release it first. The registry (`getModuleIoRegistry`) lists every consumed signal of the profile (INPUT, OUTPUT and ALARM; INTERNAL signals are listed apart and never bound) with its state:

- **BOUND** — a tag the rules accept.
- **INVALID** — bound to a tag the rules no longer accept (its role changed, it was given to a device signal, it now overlaps). The rules run again every time the registry is read, so nothing silently feeds the bridge.
- **UNBOUND** — no tag; `blocking` when the signal is required.

Which tag a signal may take is decided by the rules of `lib/domain/process-bridge.ts`, the same ones the bridge applies (docs/process-simulation.md → Bridge): a tag the program drives (READ_ONLY), on `%Q` or `%M` for a command into the process and on `%M` for feedback, BOOL for an on/off signal and a register for a number, a scaled range and a unit that carry the signal, no device signal on the tag, and a tag that no module holds (`tag-mapped`, `OCCUPIED_ENDPOINT`). Tags of one PLC never overlap by the tag registry's own rule, so a module cannot create overlapping registers. A tag of another factory, or of another owner, is not found.

Operations: `bindModuleSignal` (refuses a signal that is already bound), `rebindModuleSignal` (moves a bound signal), `releaseModuleSignal` (frees the tag; the tag, the PLC and the module stay as they are). The module's row is locked while a binding is made, and a tag's uniqueness is a database constraint, so two bindings racing for one tag end with exactly one. `listBindableTags(moduleId, signalKey)` returns every tag of the factory's PLCs as a candidate: free compatible ones without a refusal, the others with the rule that refuses them and who holds them, so a picker shows both.

Summaries: the registry carries per-direction counts and what the module takes of each PLC; `getFactoryIoSummary` sums what every PLC of a factory gives to modules and what every module takes. The PLC engineering export lists the module signals its tags carry (docs/plc-export.md).

Export and import: `exportModuleIo` writes the module's bindings by names (`schema: "z-factory.module-io"`, version 1: module name, type code and version, profile; per binding the signal, PLC name, tag name, located address and type). `importModuleIo` rebuilds them on a module of the same type version and profile, resolving PLCs and tags by name in the module's factory, all or nothing.

Runtime: the process bridge reads the stored bindings (`planProcessBridge` without mappings) and `startFactory` starts it after the device simulation when the factory has modules to run; a module with an unbound required signal, an invalid binding or a missing device is blocked and the factory start reports why (`processNote`). Deleting a module removes its bindings; the tags stay.
