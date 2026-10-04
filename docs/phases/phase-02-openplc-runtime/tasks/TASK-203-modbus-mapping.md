# TASK-203 — Modbus Mapping & External Ports

Status: **PLANNED**
Linear: [ZFA-10](https://linear.app/recruit-verse/issue/ZFA-10)

## Objective
Map persisted PLC tags/I/O to Modbus areas/addresses, encode/decode typed values, and expose controlled external host ports.

## Acceptance criteria
- Deterministic mapping with explicit area/address convention.
- Address collision/range validation.
- BOOL/UINT/INT/FLOAT32 mapping support with word count, scaling, byte order and word order metadata.
- Command/setpoint tags are distinguishable from feedback/status/alarm/process-value tags.
- Read/write permissions enforced.
- Host-port collision/bind validation.
- External-client connectivity test.
- Mapping visible in PLC inspector/export contract.
