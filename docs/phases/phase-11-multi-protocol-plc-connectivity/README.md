# Phase 11 — Multi-Protocol PLC Connectivity (Modbus TCP + OPC UA)

Status: **PLANNED**

## Goal

Allow each PLC in a Z-Factory factory to independently use either **Modbus TCP** or **OPC UA** for edge communication, while one Thin Client Agent handles both protocol types concurrently and publishes one normalized telemetry/command model to Web Factory over MQTT.

A factory may therefore contain a mixture such as:

```text
PLC-A (OPC UA) ----\
PLC-B (Modbus TCP) -\
PLC-C (OPC UA) ------> Z-Factory Thin Client Agent -> MQTT -> Web Factory
PLC-D (Modbus TCP) -/
```

The protocol choice belongs to the **PLC instance**, not to the whole factory.

## Architecture principles

### Per-PLC protocol selection

During PLC engineering/configuration, the user selects:

- `MODBUS_TCP`
- `OPC_UA`

The selected protocol is validated against the PLC/catalog capability and becomes part of the versioned Edge Deployment JSON.

### Protocol-adapter boundary

```text
PLC Worker
   |
   +--> Modbus TCP Adapter
   |      - register/coil mapping
   |      - polling
   |
   +--> OPC UA Adapter
          - endpoint/session
          - security policy/mode
          - NodeId mapping
          - subscriptions/monitored items
```

Both adapters emit the same normalized tag/value/event model upward. MQTT/cloud code must not need protocol-specific handling for ordinary telemetry.

### Read strategy

- **Modbus TCP:** poll configured registers/coils at the deployment polling interval.
- **OPC UA:** prefer subscriptions/monitored items for configured nodes; use explicit reads only where required.

No protocol performs unrestricted tag discovery during normal runtime. Engineering deployment config remains authoritative for what is monitored and writable.

### Command path

```text
Web Factory
  -> MQTT command/setpoint
  -> Thin Client command validation/idempotency/expiry
  -> selected PLC protocol adapter
     -> Modbus write OR OPC UA Write
  -> PLC command/setpoint variable
  -> PLC logic/interlocks
  -> physical output
```

ADR-0015 remains mandatory: cloud/edge never bypass PLC program authority or write arbitrary physical outputs.

## Phase 11 tasks

| Task | Status | Scope |
|---|---|---|
| TASK-1101 | PLANNED | PLC protocol capability + per-instance protocol selection |
| TASK-1102 | PLANNED | Versioned multi-protocol Edge Deployment JSON contract |
| TASK-1103 | PLANNED | Thin Client protocol-adapter interface and normalized tag model |
| TASK-1104 | PLANNED | OPC UA client/session/subscription implementation |
| TASK-1105 | PLANNED | Mixed Modbus + OPC UA worker orchestration in one agent |
| TASK-1106 | PLANNED | Multi-protocol command/write lifecycle and safety validation |
| TASK-1107 | PLANNED | Mixed-protocol factory UI, observability, migration and E2E validation |
| TASK-1108 | PLANNED | Expose Factory & generate versioned factory-level Edge Deployment JSON |

## Acceptance boundary

- Different PLCs in the same factory may select different protocols.
- Thin Client starts and supervises Modbus and OPC UA workers concurrently.
- Existing Modbus deployments remain supported.
- OPC UA deployment supports endpoint, security configuration and explicit NodeIds.
- OPC UA telemetry uses monitored-item subscriptions where supported.
- Telemetry entering MQTT is normalized and protocol-agnostic.
- Command writes are constrained to explicitly exported writable command/setpoint mappings.
- One PLC/protocol failure does not stop workers for other PLCs.
- Health/status clearly identifies protocol, connection/session state and last successful data exchange.
- E2E proves one Modbus PLC and one OPC UA PLC operate simultaneously through one Thin Client.
- **Expose Factory** validates the complete edge configuration and generates one versioned deployment JSON containing all exposed PLCs for that factory.
