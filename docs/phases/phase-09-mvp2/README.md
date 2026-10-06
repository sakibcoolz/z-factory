# Phase 09 — MVP 2: Production Edge & Cloud Integration

Status: **PLANNED**

## Goal

Turn the Z-Factory MVP foundations into the first production-oriented **MVP 2** delivery boundary: deployable edge connectivity, cloud telemetry/command transport, physical edge validation, resilience, observability and safe operation without changing PLC control authority.

## Entry criteria

Phase 09 may start when the required foundations are sufficiently stable:

- Phase 02 PLC/runtime I/O authority boundary is complete.
- TASK-503 Z-Factory Thin Client Agent contract is implemented or ready for production validation.
- Phase 08 closed-loop testing provides repeatable simulation/E2E coverage for command, feedback and failure scenarios.
- MQTT/cloud endpoint and security configuration for the target environment are available.

## MVP 2 scope

### 1. Production edge deployment
- Run the **Z-Factory Thin Client Agent** as a standalone Go binary/service on Raspberry Pi, industrial Linux gateway or equivalent edge host.
- Systemd/container deployment, restart policy, health checks and upgrade procedure.
- File-driven per-PLC configuration package from Z-Factory.
- Hot add/update/remove of PLC configurations without restarting the full agent.

### 2. Dynamic multi-PLC connectivity
- Dynamic supervised PLC workers derived from active exported configurations.
- Modbus TCP first, with protocol adapters kept extensible.
- Fault isolation so one offline/slow PLC cannot affect unrelated devices.
- Bounded concurrency, queues, reconnect/backoff and graceful shutdown.

### 3. MQTT cloud integration
- Secure MQTT telemetry uplink.
- MQTT state/heartbeat publishing.
- MQTT command downlink routed to the correct PLC worker.
- Explicit writable command/setpoint allow-list from exported configuration.
- Command idempotency and acknowledgements.
- PLC program/interlocks remain authoritative for local physical outputs.

### 4. Offline resilience
- Local durable store-and-forward when cloud/MQTT is unavailable.
- Bounded disk usage and retention.
- Restart recovery.
- Controlled backlog replay after reconnect.
- Local PLC polling/control communication continues during cloud outage.

### 5. Physical edge validation
- Replace software-only edge stand-in with a real physical/industrial edge host test.
- Validate PLC connectivity on a real LAN.
- Validate multi-PLC operation, reconnects, config changes and MQTT outage/recovery.
- Capture measurable CPU, memory, goroutine, queue and network behaviour under configurable large-N device load.

### 6. Security and observability
- TLS/mTLS or approved secure MQTT authentication.
- No plaintext production secrets in exported PLC JSON.
- Agent-level and PLC-level health state.
- Metrics/logging for connection state, poll latency, reconnects, queue/spool depth, command acceptance/rejection and MQTT status.
- Auditable command/ack identity across edge and cloud.

## Architecture boundary

```text
Z-Factory
   |
   | export/versioned PLC deployment JSON
   v
Z-Factory Thin Client Agent (Go)
   |
   +--> dynamic supervised PLC workers --> Modbus/industrial network --> PLCs
   |
   +--> bounded telemetry pipeline --> local spool --> secure MQTT --> Cloud
   |
   <-- secure MQTT commands <-- Cloud
             |
             v
        command router
             |
             v
        allowed command/setpoint
             |
             v
          PLC logic
             |
             v
      physical output/device
```

The edge/cloud layer never replaces PLC logic. Remote commands are communication inputs; PLC logic and interlocks make the final control decision.

## Exit criteria

MVP 2 Phase 09 is complete when:

- the Go Thin Client Agent is deployable on a physical edge host;
- per-PLC exported JSON drives dynamic worker lifecycle without a central database;
- multiple PLCs can be monitored concurrently with bounded resources and fault isolation;
- telemetry reaches the cloud over secure MQTT;
- cloud commands are routed safely to explicitly writable command/setpoint mappings only;
- cloud outage and reconnect are handled with local store-and-forward;
- restart and configuration hot-reload recover correctly;
- physical multi-PLC and failure/recovery E2E tests pass;
- observability demonstrates worker, MQTT, queue and spool health;
- PLC-local output authority defined by ADR-0015 remains intact.

## Task planning

Detailed Phase 09 execution tasks will be created as separate `TASK-9xx` documents before implementation starts. Phase 05 TASK-503 remains the source-of-truth design/build task for the Thin Client Agent and is a primary dependency of this MVP 2 phase.
