# Z-Factory Thin Client Agent

The edge component of Z-Factory (TASK-503, ADR-0017): a Go service on an edge host that runs
the PLCs deployed to it from exported files. It reads them over Modbus TCP, carries their
values to the cloud and passes cloud commands to their command and setpoint tags. The PLC
program stays the authority for its outputs (ADR-0015). Code: `services/zfactory-thin-client-agent/`.

Delivery is in three steps:
- **503a**: the export, the files, the workers and health.
- **503b**: the MQTT uplink, plus the command downlink with allow-list, idempotency and acks.
- **503c**: the offline spool, restart recovery and the full E2E.

All three are done.

## The deployment file
Z-Factory exports one file per PLC.
- **Where:** `GET /factories/{factoryId}/plcs/{plcId}/edge.json`, also *Edge deployment (JSON)* on the PLC's Export screen. Service: `exportEdgeDeployment` in `lib/services/edge-deployment-service.ts`; types in `lib/domain/edge-deployment.ts`.
- **Query options:** `host`, `port` (default: the runtime's published Modbus endpoint), `unitId` (1), `pollIntervalMs` (1000, 100–3 600 000) and `timeoutMs` (2000, 100–60 000). A PLC whose runtime never started needs `host` and `port` (`edge-endpoint-required`).

```json
{
  "schema": "zfactory.edge-deployment",
  "schemaVersion": 1,
  "configVersion": 7,
  "plcId": "…",
  "generatedAt": "…",
  "checksum": "sha256:…",
  "deployment": {
    "site": { "factoryId": "…", "factoryName": "…", "factorySlug": "…" },
    "plc": { "plcId": "…", "name": "PLC-01", "role": null },
    "connection": { "protocol": "MODBUS_TCP", "host": "10.0.0.15", "port": 502, "unitId": 1, "timeoutMs": 2000, "pollIntervalMs": 1000 },
    "modules": [{ "moduleId": "…", "name": "PH-01", "type": "PUMP_HOUSE" }],
    "mappings": [
      { "id": "…", "name": "Speed_SP", "access": "WRITE", "role": "SETPOINT", "authority": "EXTERNAL_COMMAND",
        "dataType": "INT16", "area": "HOLDING_REGISTER", "address": 101, "wordCount": 1,
        "byteOrder": "BIG_ENDIAN", "wordOrder": "HIGH_WORD_FIRST", "scale": 0.1, "offset": 0, "unit": "Hz",
        "min": -3276.8, "max": 3276.7, "programAddress": "%QW101" }
    ]
  }
}
```

- **Mappings.** Every mapped tag of the PLC is in the file, by stable tag id. Only external command memory (`EXTERNAL_COMMAND`: writable COMMAND and SETPOINT tags) is `WRITE`, with its engineering range. Everything else is `READ`.
- **`configVersion`** is the PLC's Modbus mapping version, which grows with every tag change.
- **`checksum`** is `sha256:` + the hex SHA-256 of the compact JSON text of `deployment`. The agent compacts the value as it appears in the file, so whitespace does not matter and any other change does.
- **No secrets.** The file carries no credentials and nothing about Docker or host paths.

## Files on the edge
`-dir` (default `/etc/zfactory-agent`) holds four directories, created on start:

| Directory | Use |
|---|---|
| `staging/` | drop new and updated files here: write a temporary name (`.x.tmp`), then rename to `*.json` |
| `active/` | what runs, one file per PLC; promoted from staging by an atomic rename |
| `rejected/` | refused files, each with `<name>.<time>.reason.json` (`rule`, `message`); the oldest beyond 200 pairs are deleted |
| `spool/` | reserved for store-and-forward (503c) |

Every scan (`-scan`, default 2 s) does three things.
1. **It re-reads `active/`.**
   - A removed file stops that PLC's worker.
   - A changed file is parsed. A file that no longer parses keeps the last good deployment in force and is reported as a problem.
   - A second file for the same PLC is ignored and reported.
2. **It handles `staging/`.** Each file must be older than `-settle` (1 s) and is handled on its own:
   - A valid file is promoted.
   - An invalid one goes to `rejected/`, and nothing that runs changes.
3. **It reconciles the workers by PLC id.**
   - A new PLC gets a worker.
   - A PLC whose checksum or version changed gets a new worker; the old one stops first.
   - A removed PLC is stopped.
   - Every other worker is left alone. The agent never restarts for this.

Refusal rules:
- **The file itself:**
  - `json`: unreadable, unknown fields, trailing data;
  - `file-size` (8 MiB);
  - `schema`, `schema-version`, `config-version`, `plc-id`;
  - `checksum`: the file was changed or cut short.
- **The connection:** `protocol` (MODBUS_TCP only), `host`, `port`, `unit-id`, `timeout`, `poll-interval`.
- **Mappings:**
  - `mapping-count` (5000);
  - `mapping-id`, `mapping-name`: missing or duplicate;
  - `mapping-type`, `mapping-area` (BOOL only on coils and discrete inputs);
  - `mapping-width`, `mapping-address`, `mapping-order`, `mapping-scale`, `mapping-access`;
  - `mapping-write`: only COMMAND or SETPOINT with authority EXTERNAL_COMMAND, on coils or holding registers;
  - `mapping-range`: a writable number needs `min <= max`.
- **Against what runs:**
  - `duplicate-plc`: another file already deploys the PLC;
  - `file-plc-changed`: the file name deploys another PLC;
  - `stale-config`: an older version;
  - `config-version-reused`: the same version with other content.

## Workers
One worker per active PLC. The count follows the files and is never fixed.

**Reading.** A worker:
- reads only the deployment's mappings, grouped into few requests: neighbours of one area share one (at most 125 registers or 2000 bits, small gaps bridged);
- decodes them with the exported type, byte and word order and scaling, as Z-Factory does (`internal/codec` mirrors `lib/protocols/modbus/codec.ts`);
- hands one batch per poll to the telemetry queue.

**Polling and limits.**
- Polls run every `pollIntervalMs`.
- A global limit (`-max-concurrent-polls`, default 64) bounds polls in flight across all PLCs.

**States.**
- `CONNECTING` while it first connects, then `ONLINE` once connected.
- `DEGRADED` while the PLC refuses a range: those values are `BAD`, the rest stay `GOOD`.
- `DISCONNECTED` / `RECONNECTING` after the PLC goes away: values keep their last reading as `DISCONNECTED`, and the worker retries with exponential backoff and jitter (0.5 s doubling to 30 s).
- `STOPPING` when it ends.
- On the status endpoint, a `GOOD` value not confirmed for three poll intervals shows as `STALE`.

**Isolation.**
- A slow or absent PLC delays only its own worker.
- A worker that panics is restarted by the supervisor after a growing delay, and reported `DEGRADED` after three panics.
- Shutdown cancels every worker and waits up to 10 s. No goroutine outlives the agent.

**Queue.** The telemetry queue (`-queue`, default 10 000 batches) is bounded: when full it drops the oldest batch and counts it, and producers never block. Until the MQTT uplink (503b), the batches are counted as discarded.

## MQTT (TASK-503b)
The uplink is optional: without `-mqtt-url` the agent runs as in 503a. MQTT settings are configuration of the agent host, never part of a deployment file.

| Flag | Environment | Use |
|---|---|---|
| `-mqtt-url` | `ZFACTORY_AGENT_MQTT_URL` | `tcp://`, `mqtt://`, or TLS `mqtts://` `ssl://` `tls://`. A URL with credentials in it is refused |
| `-site-id`, `-agent-id` | `ZFACTORY_AGENT_SITE_ID`, `ZFACTORY_AGENT_ID` | topic segments: `[A-Za-z0-9_-]{1,64}`; the agent id defaults to the host name |
| `-mqtt-client-id` | `ZFACTORY_AGENT_MQTT_CLIENT_ID` | default `zfactory-agent-<site>-<agent>`; fixed, so the session persists |
| `-mqtt-username`, `-mqtt-password-file` | `…_MQTT_USERNAME`, `…_MQTT_PASSWORD_FILE` | the password is read from a file, never from a flag, the environment or a log |
| `-mqtt-ca-file`, `-mqtt-cert-file`, `-mqtt-key-file` | `…_MQTT_CA_FILE`, `…_CERT_FILE`, `…_KEY_FILE` | broker CA and client certificate (PEM); TLS 1.2 or later |
| `-mqtt-telemetry-qos` | `…_MQTT_TELEMETRY_QOS` | 0 or 1 (default 1) |
| `-mqtt-publishers` | `…_MQTT_PUBLISHERS` | telemetry publishers shared by all PLCs (default 4) |
| `-heartbeat` | `ZFACTORY_AGENT_HEARTBEAT` | default 10 s |

Topics are under `zfactory/{siteId}/{agentId}/`:

| Topic | Direction | QoS / retained | Payload `schema` |
|---|---|---|---|
| `telemetry/{plcId}` | up | telemetry QoS, no | `zfactory.telemetry`: `plcId`, `configVersion`, `at`, `values` (`id`, `name`, `value`, `quality`, `at`) |
| `state/{plcId}` | up | 1, retained | `zfactory.plc-state`: state, version, endpoint, last poll, last error, reconnects. Published on change and every minute; cleared (empty retained) when the PLC is removed |
| `agent/heartbeat` | up | 0, no | `zfactory.agent-heartbeat`: version, uptime, workers by state, queue depth and drops, published count |
| `agent/status` | up | 1, retained | `zfactory.agent-status`: `online` on connect, `offline` on stop and as the MQTT will |
| `command/{plcId}` | down | 1 (subscribed) | `zfactory.command`, below |
| `ack/{plcId}` | up | 1, no | `zfactory.command-ack`, below |

**Connection.**
- The agent connects in the background, retrying with a growing interval up to 30 s; the agent never waits for the broker.
- The session is persistent (`cleanSession=false`), so the command subscription survives reconnects.
- Paho calls the command handler on one goroutine; the handler never blocks, and no goroutine is created per message.

**Telemetry.** A fixed pool of publishers takes batches off the shared queue. While the broker is away, or when a publish fails, the batches go to the spool below. PLC polling never waits for the cloud.

**Commands.** A command is:
```json
{ "schema": "zfactory.command", "version": 1, "commandId": "c-1029", "plcId": "…", "mappingId": "…",
  "value": 42.5, "configVersion": 7, "issuedAt": "…", "expiresAt": "…", "requestedBy": "operator-1" }
```

It is refused (`REJECTED` with a `rule`) when:
- it is not a valid command: `command-json`, `command-size` (16 KiB), `command-schema`, `command-id`;
- it names another PLC than its topic: `command-plc`;
- no such PLC is deployed: `unknown-plc`;
- it is for another configuration version than the one that runs: `stale-config-version`;
- it has expired, or expires more than 10 minutes ahead: `command-expired`, `command-expiry`;
- its mapping does not exist: `unknown-mapping`;
- its mapping is not a WRITE command or setpoint tag with authority `EXTERNAL_COMMAND`: `not-writable`;
- its value is of the wrong kind or outside the exported range: `value-type`, `value-range`.

A command that passes is acknowledged `ACCEPTED` and queued to its PLC's worker (16 waiting at most; beyond that `FAILED`/`plc-busy`, and it may be sent again). The worker:
- writes the coil, or the encoded holding registers, between polls;
- reads the tag back;
- answers `APPLIED` with `observed` (the value read back).

It answers `FAILED` with `plc-not-connected`, `plc-refused` (a Modbus exception) or `plc-write-failed`, and `plc-worker-stopped` for commands still waiting when the worker stops. What the program does next arrives with telemetry.

Every command id is remembered per PLC (10 000, for 24 h): a command delivered again is answered again with its last acknowledgement (`duplicate: true`) and never written twice. Acknowledgements are not retained, and nothing that actuates is ever retained. Each outcome is logged with the command id, mapping, value and `requestedBy`.

## Offline spool (TASK-503c)
`spool/telemetry.db` is an embedded bbolt file. It is opened when MQTT is configured, and it is the only local storage; there is still no database.

**Storing.**
- Undelivered batches are stored oldest-first under a growing sequence.
- The spool is bounded by `-spool-max-bytes` (`ZFACTORY_AGENT_SPOOL_MAX_BYTES`, default 256 MiB): the oldest batches go first when it is full.
- It is also bounded by `-spool-max-age` (`ZFACTORY_AGENT_SPOOL_MAX_AGE`, default 7 days): older batches are pruned every minute.
- Dropped batches are counted.

**Restart.** The file survives an agent restart, so the backlog is still there when the agent comes back.

**Replay.** Once the broker is back, one replayer:
- sends the backlog oldest first, at `-replay-rate` (`ZFACTORY_AGENT_REPLAY_RATE`, default 50 batches/s), on the same telemetry topic with `"replayed": true` and the original `at`;
- deletes a batch only after the broker took it.

The live publishers run beside the replayer, so live telemetry is never held behind the backlog.

**Failure.** A spool that cannot be opened (e.g. a damaged file) is reported in health, and the agent runs without it. A failing write costs that batch only, and is counted. No worker ever stops because of the spool.

## Health
The health endpoint (`-health`, default `127.0.0.1:9180`) is read-only:

| Path | Body |
|---|---|
| `GET /healthz` | `status` (`ok`, or `degraded` when a PLC is not online or an active file has a problem), version, uptime, workers |
| `GET /v1/status` | agent (version, uptime, workers by state, started/stopped), files (active, promoted, recent rejections, problems), queue (depth, capacity, pushed, dropped), uplink (configured, connected, broker without credentials, client id, topic root, published, errors, connects, connections lost, last error, command counts, spooled, lost, replayed, and the spool: entries, bytes, max bytes, oldest, written, replayed, dropped, error, replay rate), every PLC (state, endpoint, version, checksum, mappings, writable, polls, failures, reconnects, last poll, last error, panics) |
| `GET /v1/plcs/{plcId}` | one PLC with its values (`id`, `name`, `value`, `quality`, `at`) |
| `GET /metrics` | Prometheus text: uptime, active configs, rejections, workers by state, queue depth and drops, MQTT connected, spool entries, bytes, oldest age and drops, and per PLC: up, polls, reconnects |

## Running it
`services/zfactory-thin-client-agent/README.md` lists the flags and their environment variables. `packaging/zfactory-agent.service` is a hardened systemd unit (own user, `ProtectSystem=strict`, write access to its directory only).

## As built (TASK-503a)
- The export, the file lifecycle, the workers, the supervisor, the queue and health above.
- **Tests:**
  - Go unit and integration tests with an in-memory Modbus server (`internal/modbustest`), all passing `go test -race ./...`. They cover the tests of the task document:
    - 0, 1 and N configurations;
    - hot add, update and remove of one PLC;
    - malformed, partial, changed, stale and duplicate files refused in isolation;
    - an offline PLC and a slow PLC isolating only themselves;
    - panic isolation;
    - graceful shutdown with no goroutine left;
    - a configurable large-N load test (`ZFACTORY_AGENT_LOAD_N`: 1000 PLCs, about 2 goroutines each counting the fake PLCs' own, 17 MiB heap, bounded queue).
  - `test/integration/edge-agent.test.ts` covers the export rules (PostgreSQL). With `TEST_DOCKER=1 AGENT_BIN=…`, the built agent runs from a file exported for a real OpenPLC runtime:
    - it reads the same values Z-Factory reads;
    - it refuses a tampered file;
    - it reloads a new configuration version without a restart.
- **Not yet:** MQTT, commands, and the spool (503b, 503c).

## As built (TASK-503b)
- The MQTT uplink and command downlink above: packages `uplink` (Paho) and `command`, a command writer per worker, and `Commander` routing in the supervisor.
- **Tests:**
  - `internal/command`: every refusal rule and the idempotency cache.
  - `internal/worker`: a write and its read-back, a refused write, not connected, the bounded queue, nothing written after stop.
  - `internal/uplink` (`ZFACTORY_AGENT_DOCKER=1`, an `eclipse-mosquitto:2` container). It checks:
    - both PLCs' telemetry through a shared pool of two publishers, retained state, heartbeat, `online`;
    - a setpoint ACCEPTED then APPLIED and written once;
    - a redelivered command answered as a duplicate and not written again;
    - nine refusals, each with its rule, and nothing written; the other PLC untouched;
    - the broker restarted: polling never stopped, telemetry resumed, and a command after the reconnect applied;
    - a removed PLC's retained state cleared, and `offline` on stop;
    - settings that would put a password in the URL or a wildcard in a topic refused.
  - The load test with commands: 1000 PLCs, 3010 goroutines (two per worker plus the fake PLCs'), 29 MiB heap.
- **Not yet:** the spool and its replay, restart recovery of telemetry, and the end-to-end test with a real OpenPLC runtime over MQTT (503c).

## As built (TASK-503c)
- The spool and replay above (package `spool`, bbolt v1.5.0), wired into the uplink and the agent. Spool and MQTT figures are added to `/metrics`.
- **Tests:**
  - `internal/spool`: order across a restart, the size and age limits, and a damaged file refused.
  - `internal/uplink` (Mosquitto):
    - the broker is stopped and the spool fills;
    - the agent is stopped and started again while the broker is still away, and the backlog is kept;
    - when the broker returns, the backlog is replayed in order, completely, at the replay rate, with live telemetry arriving during the replay; the metrics show the spool empty and MQTT connected.
  - `test/integration/edge-agent.test.ts`, the end-to-end test of the task: a real OpenPLC runtime, an `eclipse-mosquitto:2` container, and the built agent. `mosquitto_sub` and `mosquitto_pub` inside the broker play the cloud. The test runs:
    1. an exported file;
    2. telemetry over MQTT equal to Z-Factory's reads;
    3. a `Speed_SP` command ACCEPTED and APPLIED, after which the program's `Speed_Ref` follows in telemetry;
    4. a `Start_Cmd` stop that turns `Running` off;
    5. a command to `Running` REJECTED `not-writable`, with the PLC unchanged;
    6. a broker outage spooled across an agent restart, then replayed until the spool is empty.
