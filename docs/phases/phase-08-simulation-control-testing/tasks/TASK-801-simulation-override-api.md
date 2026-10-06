# TASK-801 — Simulation Override Runtime Contract & Go API

Status: **PLANNED**

## Goal
Create a controlled runtime API for overriding simulated sensor/process inputs without directly modifying PLC outputs.

## User stories
- As a tester, I can temporarily set a simulated temperature, pressure, level, flow or other supported process input.
- As a tester, I can clear an override and return the input to normal simulation.
- As an engineer, I can distinguish AUTO, MANUAL_OVERRIDE and SCENARIO state.

## Proposed contract
Example resource semantics:

```text
PUT    /simulations/{simulationId}/devices/{deviceId}/inputs/{inputId}/override
DELETE /simulations/{simulationId}/devices/{deviceId}/inputs/{inputId}/override
```

Example payload:

```json
{
  "mode": "MANUAL_OVERRIDE",
  "value": 46
}
```

The concrete API may evolve during implementation, but the semantics above are fixed.

## Runtime behavior
Each overrideable input keeps:
- input identity
- current mode
- calculated value
- effective value
- optional override value
- engineering unit
- timestamp
- source/operator metadata where available

Tick rule:

```text
MANUAL_OVERRIDE -> effective = override value
SCENARIO        -> effective = scenario value
AUTO            -> effective = model-calculated value
```

## Validation
- Reject values outside the simulation signal's allowed engineering range.
- Reject incompatible types/units.
- Reject override on outputs/actuator command endpoints.
- Reject unknown module/device/input identifiers.
- Clearing an absent override is idempotent.

## Acceptance criteria
- Go simulation service exposes tested override/clear operations.
- Override state survives normal ticks but not unintended permanent configuration changes.
- AUTO resumes correctly after clear.
- The process bridge consumes the effective value.
- No PLC local output is directly written by this API.
