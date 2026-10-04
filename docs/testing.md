# Testing Strategy

## Layers
- Unit: domain rules, mappings, codecs, validators, compatibility and simulator state machines.
- Component: compact/modular forms, peripheral picker, I/O occupancy, topology and export views.
- Integration: PostgreSQL/Prisma, Docker adapter, OpenPLC runtime, program deploy/reload, Modbus mapping, shared device simulator.
- End-to-end: factory creation -> PLC program execution -> device response -> live telemetry -> external Modbus command/readback -> PLC export.

## Mandatory high-risk tests
- Docker options cannot escape the allow-list.
- Port/subnet collisions.
- Compact/modular rack/module/I/O compatibility.
- Duplicate PLC endpoint assignment is rejected.
- Modbus address collisions and typed codec/byte-order behavior.
- Command/setpoint tags cannot be confused with feedback/status permissions.
- Gateway writes flow through PLC logic rather than directly mutating simulator state.
- VFD ramp/state/fault behavior and one-VFD-to-primary-motor invariant.
- Motor/pump/valve/sensor simulator state transitions.
- Runtime vs persisted-snapshot boundary.
- Runtime crash/disconnect/stale-value handling.
- External connectivity only through intended published ports.
- PLC export contains required engineering data and excludes secrets.

## End-to-end reference scenario
Pressure/level sensor -> OpenPLC logic -> VFD -> motor -> pump/process -> feedback tags; external edge gateway writes a setpoint/command and reads actual feedback; UI displays live state and an engineering export is generated.

## Definition of Done
Relevant tests pass locally/CI; new behavior has tests; failures and evidence are recorded in the task file.
