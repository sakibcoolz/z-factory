# TASK-502 — End-to-End MVP Demo

Status: **PLANNED**
Linear: [ZFA-19](https://linear.app/recruit-verse/issue/ZFA-19)

## Objective
Demonstrate a complete PLC-authoritative industrial loop with external Modbus interaction.

## Demo chain
```text
sensor/process value -> OpenPLC -> VFD setpoint -> motor -> pump/process
                    -> feedback tags -> external gateway + Z-Factory UI
```

## Acceptance criteria
- Reproducible setup/runbook.
- Factory start/stop lifecycle.
- PLC code executes inside OpenPLC container.
- Multiple factory devices are uniquely named and connected.
- Live topology/tag/runtime state.
- Gateway writes a PLC command/setpoint and reads resulting feedback.
- Setpoint vs actual value is visible.
- At least one interlock/fault scenario.
- Events/alarms/history recorded according to persistence rules.
- PLC engineering export produced for the demo PLC.
- Test evidence and final docs.
