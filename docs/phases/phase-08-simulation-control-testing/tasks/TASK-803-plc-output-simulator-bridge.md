# TASK-803 — PLC Output → Simulator Command Bridge

Status: **PLANNED**

## Goal
Make PLC-program-generated outputs drive the correct simulated actuator/device commands while preserving the PLC as control authority.

## Required flow

```text
PLC program
 -> program-driven output/tag
 -> process/device bridge
 -> simulated device command
 -> Go behavior/physics model
 -> actual feedback/process value
 -> bridge
 -> PLC input/feedback tag
```

Examples:
- PLC `RUN` output -> VFD simulator run command.
- PLC speed/frequency output -> VFD simulator setpoint.
- VFD simulator -> actual frequency/current/torque.
- Motor simulator -> actual RPM/current/temperature.
- Pump/process model -> pressure/flow.
- PLC valve command -> simulated valve movement -> actual position/end-switch feedback.

## Rules
- Command/setpoint and actual feedback remain separate.
- Bridge reads program-generated outputs; UI does not manufacture those outputs.
- Simulated actuator response can be dynamic (ramp, delay, inertia, limits, faults), not instantaneous unless the model says so.
- The bridge must preserve quality/stale/disconnected semantics.
- Do not reinterpret a raw Modbus write to a local output as the normal control flow; follow ADR-0015.

## Acceptance criteria
- A PLC output change reaches the intended simulated actuator.
- Simulator behavior changes over time according to the device/process model.
- Feedback returns to mapped PLC inputs/tags.
- Loss/staleness produces explicit quality rather than false healthy state.
- Closed-loop tests verify at least VFD/motor/process and valve-style command/feedback paths.
