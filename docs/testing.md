# Testing Strategy

## Layers
- Unit: domain rules, mappings, validators, compatibility.
- Component: dynamic compact/modular forms and topology behavior.
- Integration: PostgreSQL/Prisma, Docker adapter, OpenPLC runtime, Modbus mapping.
- End-to-end: factory creation -> runtime start -> telemetry -> external Modbus client.

## Mandatory high-risk tests
- Docker options cannot escape the allow-list.
- Port/subnet collisions.
- Modular rack/module compatibility.
- Modbus address collisions.
- Runtime state transitions and crash handling.
- External connectivity only through intended published ports.

## Definition of Done
Relevant tests pass locally/CI; new behavior has tests; failures and expected evidence are recorded in the task file.
