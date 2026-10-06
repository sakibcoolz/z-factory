# TASK-802 — Simulation Override UI & Operator Controls

Status: **PLANNED**

## Goal
Expose safe test controls in Z-Factory UI for simulation inputs.

## UX
For overrideable sensor/process inputs show:
- current effective value
- engineering unit
- source: AUTO / MANUAL_OVERRIDE / SCENARIO
- Set Override action
- Clear Override action
- validation message
- last change timestamp

Example:
`TT-101 Temperature | AUTO 38.2 °C | Override…`

Test:
`TT-101 Temperature | MANUAL_OVERRIDE 46.0 °C | Clear`

## Rules
- Browser calls Z-Factory server actions/routes; it does not call the Go service directly.
- Controls appear only for simulation inputs declared overrideable.
- PLC outputs are read-only in this testing UI.
- UI clearly warns that changing a simulated input may cause PLC logic to actuate outputs.
- Clearing returns to AUTO; no hidden stale override remains.

## Acceptance criteria
- User can set 46 °C from UI and see the simulator report MANUAL_OVERRIDE.
- Invalid ranges/types are rejected with a useful message.
- Clear returns the input to AUTO.
- Live UI shows the effective value and resulting PLC/device state.
