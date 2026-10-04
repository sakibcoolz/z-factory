# TASK-203 — Modbus Mapping & External Ports

Status: **DONE**
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

## Evidence (2026-10-05)
- **Deterministic mapping, explicit convention.** The Modbus area and zero-based address are derived from the tag's located address by the runtime's fixed layout (`lib/protocols/modbus/located-address.ts`); display notation is derived, never stored.
- **Collision and range validation.** Out-of-range and unsupported addresses are rejected; overlap counts every word of multi-word values; the database adds unique and CHECK constraints.
- **Typed mapping.** BOOL, INT16, UINT16, INT32, UINT32 and FLOAT32 codecs with word count, scale/offset, byte order and word order; verified on the runtime with `REAL` and `DINT` at `%MD`.
- **Roles.** Access mode is derived from the role; a command or setpoint on an input address is refused.
- **Permissions enforced.** `writeTag` refuses non-command/setpoint tags before sending anything; refused writes change nothing on the PLC and leave no command record.
- **Host-port collision/bind validation.** `configureModbusEndpoint` checks allowed bind addresses, the port range, published ports and database reservations.
- **External-client connectivity.** A plain Modbus client outside the factory network reads and writes through the configured host endpoint; a container on the factory network reaches `plc-01:502`, one on the default bridge does not.
- **Visible in inspector/export contract.** `getModbusMap` is that contract, and each deployment snapshot stores the tag map.
- Tests: 21 unit tests (mapping table, codecs with all order combinations, function 16), 7 PostgreSQL tests (registry), 8 tests against the real runtime with PostgreSQL. 279 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.

## Changed from TASK-202
- Removing a PLC's runtime now keeps its Modbus endpoint (it is configuration); only the management port is released.
- `RUNTIME_BIND_ADDRESSES` must include `127.0.0.1`.

## Not in this task
- No screen uses the tag services yet; the I/O Mapping and Live Tags screens still render fixtures.
- The runtime's Modbus server cannot enforce per-register permissions for clients that reach the port directly (documented in `docs/security.md`).
- Checking the tag registry against a program's located variables; generating tags from the PLC configuration form (TASK-302).
- Gateway tag mappings (Phase 05) and PLC-to-PLC mappings (Phase 07).
