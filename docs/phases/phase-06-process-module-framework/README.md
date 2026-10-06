# Phase 06 — Process Module Framework & Go Simulation Service

Status: **IN PROGRESS**

## Purpose
Add a process-module abstraction and an isolated Go simulation service without changing the completed/current MVP implementation path.

A process module is the unit that owns process-specific composition and the list of PLC inputs/outputs it consumes. Generic PLCs, sensors, drives, controllers and field devices remain reusable catalog/device entities.

## Gate
Phase 06 starts only after the Phase 02–05 runtime, device-modeling, telemetry and gateway foundations are stable enough to integrate through versioned contracts.

| Task | Status |
|---|---|
| TASK-601 Process module domain & persistence | DONE |
| TASK-602 Go simulation service foundation | DONE |
| TASK-603 Simulator/Modbus closed-loop bridge | DONE |
| TASK-604 Process module designer & validation | PLANNED |
| TASK-605 Module PLC I/O registry & allocation | DONE |

## Key architecture rule
A module such as a boiler does not hard-code or assume a fixed PLC I/O count. Its module type declares required/optional logical signals, and each module instance registers/binds those signals to actual PLC tags, I/O points or protocol mappings.

Example:

```text
Boiler Module
  INPUTS  -> TT_BOTTOM, TT_MIDDLE, TT_TOP, LEVEL, PRESSURE, FLOW, HEATER_FAULT
  OUTPUTS -> HEATER_ENABLE, HEATER_POWER, PUMP_CMD, INLET_VALVE_CMD
                         |
                         v
             Module PLC I/O Registry
                         |
                         v
         Existing PLC tags / I/O / Modbus mapping
```

## Exit criteria
Z-Factory can define a reusable process-module type, create a factory-specific module instance from existing devices, register the module's logical PLC I/O contract, allocate those signals to valid PLC tags/I/O points, run a deterministic Go process model, and exchange PLC-authoritative commands/feedback without breaking existing Phase 02–05 behavior.
