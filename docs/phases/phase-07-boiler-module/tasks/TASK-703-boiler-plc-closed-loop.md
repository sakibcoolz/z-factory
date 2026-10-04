# TASK-703 — Boiler Closed-Loop PLC Integration

Status: **PLANNED**

## Goal
Run the boiler process model under PLC control using mapped virtual sensor inputs and PLC output commands.

## Scope
- temperature/level/process feedback mappings
- heater enable/output mappings
- optional pump/valve command mappings
- OpenPLC reference program for setpoint/hysteresis or PID test
- optional target-band hold timer in PLC logic
- fault/interlock test cases
- end-to-end timing/quality/disconnect tests

## Invariants
- PLC decides heater/pump/valve commands.
- Boiler simulator only calculates resulting process state.
- Virtual sensor values enter PLC through the same validated tag/protocol boundary as other simulator feedback.
- Safety-related behavior is simulation only and not safety-rated.

## Acceptance
- PLC reads simulated boiler temperatures through mapped inputs.
- PLC output changes affect subsequent simulated temperature.
- A reference scenario can heat from 20 °C toward a 43 °C target and maintain a configured band using PLC logic.
- Optional hold time starts only after the configured target condition is satisfied.
- Fault/disconnect behavior is visible and testable.
