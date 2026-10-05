# TASK-605 — Module PLC I/O Registry & Allocation

Status: **PLANNED**
Linear: [ZFA-28](https://linear.app/recruit-verse/issue/ZFA-28)

## User story
As a Z-Factory engineer, I want every process-module instance to explicitly register the PLC inputs and outputs it consumes so that a boiler, tank, conveyor cell or future module can be connected to a PLC without hard-coding a universal I/O count or changing unrelated device/runtime code.

## Goal
Create one authoritative module-level registry that answers:
- which logical PLC inputs the module consumes
- which logical PLC outputs the module consumes
- which signals are required vs optional
- which concrete PLC/tag/I/O/Modbus endpoint each signal is bound to
- whether each binding is valid, occupied, stale or missing

## Scope
- ModuleSignalDefinition as the reusable logical contract
- ModulePlcIoMapping as the factory-specific binding
- module I/O registry service/query
- required/optional signal validation
- PLC ownership and same-factory checks
- channel/tag compatibility validation
- I/O occupancy and Modbus register-overlap validation
- bind, rebind and release operations
- consumed-I/O summary per module and per PLC
- export/import representation
- tests and API/UI documentation

## Direction convention
Directions are from the PLC program perspective.

- INPUT: PLC reads process/device feedback.
- OUTPUT: PLC writes command/setpoint.
- INTERNAL: simulator/runtime value not directly mapped to PLC I/O.
- ALARM: alarm/status signal exposed according to the selected profile.

## Example
```text
BOILER-01
  INPUT  TT_BOTTOM       -> PLC-01 / tag TT_BOTTOM       / Input Register
  INPUT  TT_MIDDLE       -> PLC-01 / tag TT_MIDDLE       / Input Register
  INPUT  TT_TOP          -> PLC-01 / tag TT_TOP          / Input Register
  INPUT  LEVEL           -> PLC-01 / tag LT_101          / Input Register
  OUTPUT HEATER_ENABLE   -> PLC-01 / tag HEATER_ENABLE   / Coil
  OUTPUT HEATER_POWER    -> PLC-01 / tag HEATER_POWER    / Holding Register
  OUTPUT PUMP_CMD        -> PLC-01 / tag PUMP_CMD        / Coil
```

The exact count is profile/configuration driven. The framework must not claim that every boiler consumes the same number of PLC points.

## Invariants
- The registry reuses normal Z-Factory Tag, PlcIoPoint and protocol-address rules.
- A module cannot create a parallel PLC address space.
- A module cannot bind a device, PLC or tag from another factory.
- One physical PLC endpoint cannot be allocated twice unless the underlying endpoint semantics explicitly permit sharing.
- Data type, direction, access mode, signal type, engineering unit/scaling and multi-word register span must be validated.
- Releasing a module mapping must not delete the underlying reusable device or PLC unless a separate delete operation requests it.
- PLC remains the control authority.

## Acceptance
- User can inspect the complete consumed input/output list for a module instance.
- Required unmapped signals block module runtime start with a clear validation result.
- Optional signals may remain unbound without blocking runtime.
- Compatible free PLC endpoints can be bound and incompatible/occupied endpoints are rejected.
- Rebinding/releasing updates occupancy correctly.
- An export reconstructs logical signal -> PLC tag/I/O/register bindings.
- Tests cover duplicate allocation, cross-factory binding, wrong direction/type, register overlap and required-signal validation.
