# TASK-503 — Z-Factory Thin Client Agent: File-Driven Dynamic PLC Connectivity, Concurrency & MQTT Cloud Uplink

Status: **IN PROGRESS** (503a done; 503b, 503c follow)
Linear: [ZFA-43](https://linear.app/recruit-verse/issue/ZFA-43)

Phase: **05 — External Gateway MVP**

## Objective

Build a standalone, database-independent Go service named **Z-Factory Thin Client Agent** for Raspberry Pi, industrial gateway or Linux edge hosts. The agent loads exported PLC deployment JSON files from a local staging area, starts and supervises one logical worker per configured PLC, reads telemetry through industrial protocols (Modbus TCP first), publishes telemetry to cloud through MQTT, and routes validated cloud commands/setpoints back to the correct PLC without bypassing PLC control logic.

## Core flow

```text
Z-Factory UI / Export
        |
        v
Versioned per-PLC JSON files
        |
        v
Edge staging directory
        |
        v
Z-Factory Thin Client Agent (Go)
        |
        +--> config validation / reconciliation
        +--> Device Supervisor
        |      +--> PLC worker A -- Modbus TCP --> PLC-A
        |      +--> PLC worker B -- Modbus TCP --> PLC-B
        |      +--> ... dynamic N workers
        |
        +--> bounded telemetry queue
        +--> local durable spool / store-and-forward
        +--> bounded MQTT publisher pool -----------> Cloud
        +<-- MQTT command subscriber <--------------- Cloud
                    |
                    v
              command router
                    |
                    v
              target PLC worker
                    |
                    v
         validated command/setpoint write
                    |
                    v
               PLC program
                    |
                    v
            local physical output
```

## Edge source of truth

The agent has **no direct PostgreSQL/MySQL/central database dependency**. Edge desired state is the deployment package exported by Z-Factory.

Suggested layout:

```text
/etc/zfactory-agent/
  staging/
    plc-001.json
    plc-002.json
  active/
  rejected/
  spool/
```

Each PLC JSON MUST include:
- `schemaVersion`, `configVersion`, `checksum`
- stable `plcId`, PLC name, factory/site identity
- protocol and connection settings
- Modbus host/port/unit id when applicable
- module membership and PLC sharing context
- canonical input/output/pin mappings exported from Z-Factory
- writable command/setpoint mappings
- read-only feedback/status/telemetry mappings
- polling/timeout policy
- optional MQTT topic metadata
- credential references only; never plaintext production secrets

## Startup and file lifecycle

1. Start logging, metrics, local spool and MQTT client.
2. Scan `staging/*.json` and `active/*.json`.
3. Parse and validate schema, version, checksum, duplicate `plcId`, mappings, ranges and protocol settings.
4. Invalid PLC config is rejected in isolation; the agent continues.
5. Valid staging config is atomically promoted to `active/`.
6. Reconcile desired PLC set against running workers.
7. Start one supervised logical worker per active PLC.

Hot reload rules:
- add valid JSON -> start worker
- update config -> validate first, then replace/reconfigure only that PLC worker
- remove config -> gracefully stop only that worker
- invalid update -> keep last-known-good config
- duplicate `plcId` -> reject candidate
- partial write -> never load; deployment uses write-temp-then-rename
- no agent restart for normal add/update/remove

## Dynamic concurrency model

The PLC count is dynamic, never fixed to 150 or any other number.

```text
Active JSON configs = N
        |
        v
Device Supervisor
        |
        +--> N logical PLC workers
```

Requirements:
- worker count derives from active config
- one PLC failure cannot stop other workers
- each worker owns its connection lifecycle and polling state
- `context.Context` cancellation controls lifecycle
- no unbounded goroutine creation
- no unbounded channels
- bounded queues with explicit overflow/backpressure policy
- configurable global/per-device rate limits
- worker states: `DISCONNECTED`, `CONNECTING`, `ONLINE`, `DEGRADED`, `RECONNECTING`, `STOPPING`
- exponential reconnect backoff with jitter
- graceful shutdown with bounded flush deadline
- race-safe state; CI runs `go test -race ./...`
- worker panic is isolated/reported by supervisor; repeated failure degrades only that PLC

A worker may internally own small read/command/protocol goroutines, but all must terminate with the worker context.

## PLC telemetry path

```text
PLC worker
 -> read exported mappings only
 -> decode typed values
 -> timestamp + quality + plcId + mapping id
 -> bounded telemetry queue
 -> optional batching
 -> local durable spool when cloud is unavailable
 -> shared MQTT publisher pool
 -> Cloud
```

Rules:
- never blindly scan full Modbus address space
- preserve type/width/register ordering from export
- explicit GOOD/STALE/DISCONNECTED quality
- configurable polling interval
- slow PLC cannot block unrelated PLCs

## MQTT cloud uplink/downlink

Suggested topics:

```text
zfactory/{siteId}/{agentId}/telemetry/{plcId}
zfactory/{siteId}/{agentId}/state/{plcId}
zfactory/{siteId}/{agentId}/command/{plcId}
zfactory/{siteId}/{agentId}/ack/{plcId}
zfactory/{siteId}/{agentId}/agent/heartbeat
```

Requirements:
- TLS in production
- client certificate/token reference supported
- configurable broker URL/client id
- persistent session where appropriate
- QoS configurable; design target QoS 1 for important telemetry/events
- command id + idempotency for at-least-once delivery
- unsafe actuation commands are not retained
- shared bounded publisher pool; do not create uncontrolled broker publishers per PLC
- independent heartbeat
- reconnect with backoff/jitter
- cloud outage does not stop local polling

## Offline store-and-forward

No central DB is required, but a local durable spool is required for production resilience.

Requirements:
- embedded/local storage only
- bounded disk usage
- retention/max spool size policy
- restart recovery
- controlled backlog replay after MQTT reconnect
- real-time telemetry must not be permanently starved by replay
- spool failure degrades forwarding but does not crash healthy PLC workers
- storage hidden behind a small interface

## Cloud command path

```text
Cloud
 -> MQTT command/{plcId}
 -> validate envelope + command id
 -> command router
 -> target PLC worker
 -> verify exported writable mapping
 -> typed Modbus write to COMMAND / SETPOINT mapping only
 -> observe resulting PLC feedback
 -> publish ACK/result
```

Safety rules:
- never write arbitrary Modbus addresses from cloud
- target must exist in exported writable allow-list
- remote control writes command/setpoint communication tags only
- do not directly force the PLC local physical output image in normal control
- PLC program/interlocks remain authoritative
- reject unknown PLC/mapping, type mismatch, out-of-range value, stale config version, unauthorized command
- idempotency prevents duplicate actuation
- ACK distinguishes accepted/rejected/applied/failed

## Fault isolation / no-breakage requirements

- malformed JSON affects only that candidate
- one offline PLC affects only that worker
- slow PLC cannot block MQTT or other PLCs
- MQTT outage does not stop polling
- local spool failure does not terminate workers
- invalid config update never replaces last-known-good config
- every goroutine has explicit owner/shutdown
- resource limits are configurable
- health output exposes agent and per-PLC state

## Observability

Expose:
- agent version/build and uptime
- active config count
- worker count by state
- MQTT status
- spool depth/bytes/oldest item
- per-PLC connection state
- last successful poll/error
- reconnect count
- queue depth
- command counts/rejections

A safely bound local HTTP health/metrics endpoint is acceptable.

## Deployment

Targets:
- standalone Go binary
- systemd on Linux/Raspberry Pi/industrial PC
- optional Docker container for virtual testing

Repository location:
`services/zfactory-thin-client-agent/`

Binary:
`zfactory-agent`

The service runs independently from Next.js and imports no application TypeScript code.

## Tests

1. 0 configs -> healthy, 0 workers.
2. 1 valid config -> 1 worker.
3. N configs -> N logical workers dynamically.
4. Add config -> worker starts without restart.
5. Update config -> only target worker reloads.
6. Remove config -> only target worker stops.
7. Malformed/partial/duplicate config -> rejected; others remain healthy.
8. One PLC offline -> other PLCs continue.
9. MQTT offline -> polling continues, telemetry spools.
10. MQTT recovers -> bounded backlog replay.
11. Multiple PLC telemetry goes through shared bounded publisher pool.
12. Cloud command routes only to target PLC.
13. Unmapped/arbitrary Modbus write is rejected.
14. Allowed command/setpoint write succeeds.
15. Duplicate command id cannot duplicate actuation.
16. Restart recovers active configs and spool.
17. Graceful shutdown leaks no goroutines.
18. `go test -race ./...` passes.
19. Configurable large-N load test proves bounded memory/goroutine/queue behavior.
20. E2E: exported JSON -> agent -> Modbus PLC -> MQTT telemetry -> MQTT command -> allowed command tag -> PLC logic -> feedback -> MQTT ack/telemetry.

## Acceptance criteria

- Standalone Go **Z-Factory Thin Client Agent** exists.
- No central SQL/PostgreSQL dependency.
- Per-PLC exported JSON is the edge desired-state source.
- Add/update/remove reconciles workers dynamically.
- Worker count is not fixed.
- Modbus reads are isolated per PLC.
- MQTT uplink/downlink uses bounded queues and reconnect handling.
- Offline store-and-forward survives cloud outage and agent restart.
- Cloud commands can write only explicitly exported command/setpoint mappings.
- PLC logic remains authoritative for physical outputs.
- Invalid config, one failed PLC or cloud outage cannot bring down healthy PLC communication.
- Health/metrics expose worker/MQTT/spool state.
- Unit/race/integration/E2E tests cover failure and recovery.

## Out of scope

- cloud replacing PLC control logic
- direct normal-operation forcing of PLC local physical outputs
- a central database inside the edge agent
- automatically trusting arbitrary network-discovered devices
- vendor-specific discovery beyond future adapters

## Delivery (approved 2026-10-07)
TASK-503 is delivered in three pull requests. The owner approved the dependencies `github.com/eclipse/paho.mqtt.golang` (MQTT) and `go.etcd.io/bbolt` (spool); the Modbus client is in-house (ADR-0017).

| Slice | Scope | Status |
|---|---|---|
| 503a | Z-Factory edge-deployment export; agent core: file validation and lifecycle, hot reload, supervised workers, Modbus polling, bounded queue, health/metrics, systemd unit | DONE |
| 503b | MQTT uplink (telemetry, state, heartbeat; shared bounded publisher pool) and command downlink (allow-list, validation, idempotency, acks) | TODO |
| 503c | Offline spool with restart recovery and controlled replay; full E2E exported JSON → agent → Modbus → MQTT → command → PLC logic → feedback → ack | TODO |

## As built (503a)
Design and file format: `docs/thin-client-agent.md`; decision: `docs/adr/0017-thin-client-agent.md`.

**Z-Factory side.**
- `exportEdgeDeployment` and `GET /factories/{factory}/plcs/{plc}/edge.json`, also linked from the PLC's Export screen.
- One checksummed file per PLC, with every mapped tag readable and only command and setpoint tags writable.

**Agent, `services/zfactory-thin-client-agent/`:**
- `config`: strict parsing, checksum, every validation rule;
- `deploy`: staging/active/rejected lifecycle, atomic promotion, last-known-good, refusals with reasons;
- `modbus`: an in-house client;
- `codec`: mirrors Z-Factory's codec;
- `worker`: polls in few requests, owns its states, backoff with jitter, BAD/DISCONNECTED/STALE quality;
- `supervisor`: reconciles by PLC id, panic isolation;
- `telemetry`: a bounded drop-oldest queue;
- `health`: `/healthz`, `/v1/status`, `/v1/plcs/{id}`, `/metrics`;
- `cmd/zfactory-agent`, plus `packaging/zfactory-agent.service`.

Tests 1–8, 17, 18 and 19 of the list above are covered; 503b and 503c cover the rest.

## Evidence (503a)
- `go test -race ./...` passes: codec, config, deploy, worker, supervisor and agent.
- `ZFACTORY_AGENT_LOAD_N=1000`: 1000 PLC workers online, 2010 goroutines including the fake PLCs' connections, 17 MiB heap, queue within capacity and nothing dropped.
- `test/integration/edge-agent.test.ts`:
  - Export rules against PostgreSQL: writable only `Start_Cmd` and `Speed_SP`; a valid checksum; no endpoint refused; a bad host refused; another owner gets 404.
  - With a real OpenPLC runtime and the built agent:
    - the agent reads `Start_Cmd`, `Speed_SP`, `Running`, `Speed_Ref` and `Run_Hours` equal to Z-Factory's reads;
    - a file changed after export (a version bump and a READ turned WRITE) is refused with `checksum`;
    - a new tag gives a new version that the agent reloads without a restart;
    - nothing is written through the agent.
- The Next.js checks (prettier, lint, `tsc`, build, full suite) are listed in the report.
