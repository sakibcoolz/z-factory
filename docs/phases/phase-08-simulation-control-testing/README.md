# Phase 08 — Simulation Control, Overrides & Closed-Loop Testing

Status: **IN PROGRESS**

## Purpose
Add an operator/test layer for the Go simulation service so engineers can deliberately drive simulated sensor/process inputs, observe PLC-program decisions, feed PLC outputs into simulated actuators/devices, and validate the full closed loop without bypassing PLC control authority.

This phase does not turn UI/API calls into PLC output forcing. The simulator owns simulated process values; the PLC program owns control decisions and local outputs.

## Gate
Start after the Go process simulation service and PLC bridge contracts are stable enough to expose controlled runtime test operations. TASK-205 / ADR-0015 rules remain mandatory.

## End-to-end model

```text
TEST INPUT PATH
UI
 -> Z-Factory server action/API
 -> Go simulation override API
 -> simulated sensor/process state
 -> process bridge
 -> PLC input image / mapped input tag
 -> PLC scan-cycle logic

CONTROL PATH
PLC scan-cycle logic
 -> PLC output image / command tag
 -> process bridge
 -> Go simulated VFD/valve/motor/actuator
 -> simulated physics/behavior
 -> feedback/process values
 -> PLC input image
```

## Simulation modes
- `AUTO`: value comes from the process/device model.
- `MANUAL_OVERRIDE`: a test value temporarily replaces the model-generated input.
- `SCENARIO`: a controlled profile changes one or more simulation inputs over time.

Clearing an override returns that input to `AUTO`.

## Rules
- UI never writes a PLC local output merely to create a test condition.
- UI changes the simulator's input/process state through a server-side API/client.
- PLC logic decides alarms, interlocks and local outputs.
- PLC outputs are observed by the bridge and delivered to the simulated actuator/device as commands.
- Device/process simulation calculates actual behavior and feedback; setpoint/command and actual feedback stay separate.
- Manual overrides are runtime test state, not permanent catalog configuration.
- Every override/scenario change is attributable, observable and clearable.
- Direct output forcing is outside this phase.

## Tasks

| Task | Status |
|---|---|
| TASK-801 Simulation Override Runtime Contract & Go API | DONE |
| TASK-802 Simulation Override UI & Operator Controls | DONE |
| TASK-803 PLC Output → Simulator Command Bridge | DONE |
| TASK-804 Closed-Loop Test Scenarios, Events & E2E Validation | PLANNED |

## Exit criteria
An engineer can place a simulated input into manual override, set a value such as a temperature above a PLC alarm threshold, observe that the PLC program itself raises the alarm/output, observe PLC outputs driving simulated actuators/process behavior, receive actual feedback back at PLC inputs, clear the override back to AUTO, and run repeatable closed-loop scenarios with recorded evidence.
