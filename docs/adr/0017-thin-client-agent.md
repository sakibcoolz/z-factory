# ADR-0017 — Thin Client Agent Runs From Exported Files

Status: **ACCEPTED** (TASK-503, 2026-10-07)

## Context
TASK-503 needs a deployable edge component: something on a Raspberry Pi, an industrial
gateway or a Linux PC that reads many PLCs over Modbus TCP, sends their values to the cloud
over MQTT and passes cloud commands back to the PLCs. Until now, `scripts/edge-client.mjs`
stood in for it in tests. The edge host may be offline from the cloud for long periods and
has no Z-Factory database.

## Decision
1. **A separate Go service** in `services/zfactory-thin-client-agent/`, binary
   `zfactory-agent`. It imports no application code, like the process simulation service
   (ADR-0008).
2. **Files are the desired state.** Z-Factory exports one deployment file per PLC
   (`zfactory.edge-deployment`, version 1).
   - A file carries the PLC's Modbus endpoint and every mapped tag. Only command and setpoint
     tags (`EXTERNAL_COMMAND`, ADR-0015) are marked WRITE.
   - Its integrity is a SHA-256 of the compact JSON text of its `deployment`, so any JSON
     formatting of the file verifies.
   - The agent promotes valid files from `staging/` to `active/` by rename and moves refused
     ones to `rejected/` with the reason.
   - A newer `configVersion` replaces an older one. An older or reused version, a duplicate
     PLC, or a changed file is refused, and what runs stays.
   - There is no database on the edge.
3. **One supervised worker per PLC.** The number of workers follows the active files.
   - Each worker owns its connection and backoff.
   - A global limit bounds polls in flight.
   - A panicking worker is restarted, and marked degraded after three panics; no other PLC is
     affected.
   - Telemetry goes through one bounded queue that drops the oldest batch when full, so a
     worker never blocks on it.
4. **Local observability only.** A read-only HTTP endpoint on 127.0.0.1 serves health,
   status, per-PLC values and Prometheus metrics.
5. **Dependencies.** The Modbus TCP client is in-house, like the TypeScript one. MQTT
   (TASK-503b) uses `github.com/eclipse/paho.mqtt.golang` (v1.5.1, which brings
   `gorilla/websocket`, `golang.org/x/net` and `golang.org/x/sync`). The offline spool
   (TASK-503c) uses `go.etcd.io/bbolt` (v1.5.0, with `golang.org/x/sys`). Both were approved by the owner. Nothing else is
   added without asking.

## Consequences
- A deployment reaches the edge as a file copy. The agent never pulls configuration from
  Z-Factory and needs no network path to it.
- The cloud can write only what the export marked WRITE. The agent checks it again (role,
  authority, area, range), so a hand-edited file cannot widen the allow-list, and an edited
  file fails its checksum anyway.
- The export's endpoint defaults to the PLC runtime's published Modbus port. In a plant the
  exporter gives the PLC's real address (`host`, `port`, `unitId`).
- Credentials for MQTT are configuration of the agent host, not of the deployment file.
