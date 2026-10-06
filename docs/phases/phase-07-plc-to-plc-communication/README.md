# Phase 07 — PLC-to-PLC Communication

Status: **IN PROGRESS**

## Purpose
Add first-class PLC-to-PLC communication while keeping every PLC as an independent OpenPLC runtime with its own program, tags, I/O mappings, lifecycle and Docker container.

The first supported PLC-to-PLC protocol is **Modbus TCP**.

## Gate
Phase 02 OpenPLC runtime and Modbus mapping are stable enough to run multiple PLC containers on the same isolated factory Docker network.

| Task | Status |
|---|---|
| TASK-701 PLC relationship & communication domain | DONE |
| TASK-702 Modbus TCP client/server mapping | PLANNED |
| TASK-703 PLC-to-PLC runtime adapter & Docker networking | PLANNED |
| TASK-704 PLC-to-PLC UI, validation & E2E tests | PLANNED |

## Canonical logic
```text
Supervisor PLC / PLC-A
        |
        | Modbus TCP client
        v
Machine PLC / PLC-B (Modbus TCP server)
        |
        | local PLC logic
        v
Local VFD / Motor / Valve / Sensor / Module
```

PLC-A may read status/process values from PLC-B and may write only explicitly permitted command/setpoint endpoints. PLC-B continues to execute its own local control logic.

## Exit criteria
- Multiple PLC containers communicate on the same factory Docker network.
- One PLC can operate as a Modbus TCP client to another PLC's server endpoint.
- Read/write mappings are explicit, validated and versioned.
- Cross-factory PLC links are rejected in this phase.
- Data type, register span, access mode, address overlap and connection health are validated.
- PLC-local control logic remains authoritative for the devices controlled by that PLC.
