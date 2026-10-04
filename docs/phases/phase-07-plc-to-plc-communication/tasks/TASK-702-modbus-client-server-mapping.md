# TASK-702 — Modbus TCP Client/Server Mapping

Status: **PLANNED**

## Goal
Define explicit Modbus TCP mappings for data exchange between PLC instances.

## Scope
- source PLC as Modbus TCP client
- target PLC as Modbus TCP server
- target Docker DNS/service name
- port and unit id
- remote Modbus area/address
- source/local PLC communication tag
- operation: READ or WRITE
- polling/update interval
- BOOL/INT16/UINT16/INT32/UINT32/FLOAT32 codecs
- word count, byte order and word order
- scaling and engineering units
- quality, stale and disconnected state
- register span and access validation

## Examples
```text
READ:
PLC-A(client) -> PLC-B(server) Input Register 30001
              -> PLC-A tag MACHINE_B_TEMP

WRITE:
PLC-A tag START_MACHINE_B
              -> PLC-B(server) Coil 00001
```

## Invariants
- Writes are allowed only to target endpoints configured as writable command/setpoint values.
- Feedback/status/process-value endpoints remain read-only.
- Existing Modbus data-type, address and access-mode rules are reused.
- A mapping must not silently bypass the target PLC's local control logic.

## Acceptance
- Read mappings transfer target PLC values into source PLC communication tags.
- Write mappings update only explicitly writable target endpoints.
- Type mismatch, invalid register span, address collision and invalid access mode are rejected.
- Stale/disconnected quality is visible to runtime and UI.
