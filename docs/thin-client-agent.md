# Z-Factory Thin Client Agent

The edge component of Z-Factory (TASK-503, ADR-0017): a Go service on an edge host that runs
the PLCs deployed to it from exported files. It reads them over Modbus TCP, carries their
values to the cloud and passes cloud commands to their command and setpoint tags. The PLC
program stays the authority for its outputs (ADR-0015). Code: `services/zfactory-thin-client-agent/`.

Delivery is in three steps:
- **503a**, this document's "As built": the export, the files, the workers and health.
- **503b**: the MQTT uplink, plus the command downlink with allow-list, idempotency and acks.
- **503c**: the offline spool, restart recovery and the full E2E.

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

## Health
The health endpoint (`-health`, default `127.0.0.1:9180`) is read-only:

| Path | Body |
|---|---|
| `GET /healthz` | `status` (`ok`, or `degraded` when a PLC is not online or an active file has a problem), version, uptime, workers |
| `GET /v1/status` | agent (version, uptime, workers by state, started/stopped), files (active, promoted, recent rejections, problems), queue (depth, capacity, pushed, dropped), uplink, every PLC (state, endpoint, version, checksum, mappings, writable, polls, failures, reconnects, last poll, last error, panics) |
| `GET /v1/plcs/{plcId}` | one PLC with its values (`id`, `name`, `value`, `quality`, `at`) |
| `GET /metrics` | Prometheus text: uptime, active configs, rejections, workers by state, queue depth and drops, and per PLC: up, polls, reconnects |

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
