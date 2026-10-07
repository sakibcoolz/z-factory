# TASK-903 — Telemetry Ingestion, Cloud Persistence & Latest-State Projection

Status: **DONE**
Linear: [ZFA-46](https://linear.app/recruit-verse/issue/ZFA-46)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Ingest Thin Client telemetry and operational events into Web Factory, preserve durable history and maintain efficient latest-state views for sites, agents, PLCs, modules and tags.

## Scope
- Validate and normalize versioned MQTT telemetry envelopes.
- Persist telemetry, state transitions, alarms/events and ingestion metadata.
- Maintain latest value/quality/timestamp for PLC tags and device/module state.
- Preserve GOOD/STALE/DISCONNECTED quality.
- Batch writes and apply bounded ingestion concurrency/backpressure.
- Idempotent handling using event/message ids.
- Retention/partitioning strategy for historical telemetry.
- Query APIs for time range, latest state, alarms and connection history.
- Keep storage abstraction open for a future dedicated time-series engine; PostgreSQL is the initial durable store.

## Acceptance criteria
- Telemetry from multiple dynamic PLCs is stored and queryable by tenant/site/agent/PLC/tag.
- Duplicate MQTT delivery does not create duplicate logical events.
- Latest-state projection updates deterministically.
- Stale/disconnected quality is represented explicitly.
- Ingestion overload is bounded and observable.

## Decisions (owner, 2026-10-07)
- **Storage:** per-tag rows in PostgreSQL, partitioned by day, in a `telemetry` schema outside Prisma, behind a `TelemetryStore` interface.
- **Retention:** 30 days by default, by dropping day partitions.
- **Alarms:** this task stores PLC state and tag quality changes as events; alarm rules and acknowledgement are TASK-904.

Recorded in ADR-0020.

## As built
Design: `docs/web-factory.md` → Telemetry.
- **Contract** (`lib/domain/telemetry.ts`): Web Factory's own copy of the agent's `zfactory.telemetry` batch (values: number, boolean or null; GOOD/BAD/STALE/DISCONNECTED), the latest-state walk, the quality projection, and day keys and time limits.
- **Idempotency:** a batch is identified by its PLC and poll time, because agent batches have no id and a replayed batch keeps its time. `telemetry.batch` with `ON CONFLICT DO NOTHING` decides duplicates; only new batches add samples, latest values and events.
- **Storage** (`lib/telemetry/store.ts`):
  - `telemetry.batch` and `telemetry.sample`, partitioned by UTC day; partitions are created as needed, plus today's and tomorrow's every hour, and dropped past the retention;
  - batches past the retention, or from more than 10 minutes in the future, are refused;
  - bulk inserts with `unnest`.
- **Latest state** (`TagLatest`): keyed by the tag's external id, so it survives a new registration; the newest poll wins, under a row lock. STALE (3 poll intervals) and DISCONNECTED (the PLC connection is not up, or the agent is unreachable) are projected on read.
- **Events** (`PlcEvent`), recorded once each: tag quality changes as the latest view advances, and PLC connection state changes from `state/{plcId}`.
- **Pipeline** (`lib/telemetry/pipeline.ts`):
  - the MQTT handler validates and offers, and never waits;
  - 2 writers by default, sharded by PLC so each PLC is stored in order, with bounded queues (10,000 batches in all) that drop their oldest batch and count it;
  - up to 200 batches per transaction;
  - unregistered PLCs and tags, version mismatches, and expired and future batches are counted.
- **Broker session:** Web Factory's is now persistent (a stable client id, a 1-day expiry). The broker queues up to 100,000 messages or 256 MiB per client while Web Factory is away.
- **Queries** (`lib/services/telemetry-service.ts`, `/api/v1`), all tenant-scoped:
  - latest values per PLC and per organization, site or agent;
  - a tag's raw history, or buckets with count, min, max, avg, last and the worst quality (31 days and 10,000 points at most);
  - PLC events;
  - agent connection history.
- **Observability:** telemetry counters in the `broker stats` log line; `telemetry: ok/backlogged` in `/api/ready`; a `telemetry partitions` log line.
- **UI:** the PLC page shows each tag's latest value, quality and age, and the last week's events.
- **Data:** migration `telemetry_storage`.

## Acceptance criteria — evidence
- **Telemetry from multiple dynamic PLCs is stored and queryable by tenant, site, agent, PLC and tag:**
  - end to end, two PLCs are deployed to the running real agent one after the other, and both are stored;
  - the database tests query raw and bucketed history per tag, and latest values by organization, site, agent and PLC;
  - other tenants get NOT_FOUND (404 over HTTP).
- **Duplicate delivery creates no duplicate logical events:**
  - a redelivered and a replayed batch are stored once (1 sample, 1 event);
  - the same PLC state twice records one event;
  - end to end, the agent's replayed spool after a broker outage is stored once, with as many samples per tag as batches and no repeated time.
- **Latest state updates deterministically:**
  - unit tests show the same result in any arrival order;
  - an older batch replayed after a newer one leaves the latest value alone but enters the history.
- **Stale and disconnected are explicit:**
  - projected from the PLC's reported connection, the agent's reachability and 3 poll intervals;
  - end to end, a PLC that goes away shows DISCONNECTED, with the change recorded.
- **Ingestion overload is bounded and observable:**
  - a queue of 10 with a stalled store keeps 10 and drops the 39 oldest, counted;
  - counters appear in the log line and `/api/ready`;
  - throughput on this machine: 100,000 samples (20 PLCs × 50 tags × 100 polls) in 0.7 s, about 142,000 samples per second, with no errors.

## Evidence
- `npm test` in `apps/web-factory` passes: 11 files, 62 tests, with Docker and the real agent. The broker and telemetry end-to-end suites (12 tests) passed 4 times, with every container removed.
- Root project: prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` (with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`) passes: 97 files, 1034 tests.
- The app's lint, typecheck, prettier and `next build` are clean.
- **Browser check:** headless Chromium; `next start` on 3211 against a temporary Mosquitto, a simulated Modbus PLC, the real agent with credentials issued in the browser, and a temporary organization in the dev database `web_factory`. The database was empty before and is emptied again, including its day partitions.
  1. `/api/ready` reports `database ok, mqtt connected, telemetry ok`. Start-up creates today's and tomorrow's partitions.
  2. The PLC page shows live values: Running on and Speed_SP in Hz, with good quality and their age, refreshed every 500 ms. Its events show the PLC going online and the tags becoming good.
  3. The API answers in the browser session: latest values, history, 10 s buckets, events, connection history, and latest values for the site. Another organization gives 404; a range of 59 days gives 400.
  4. With the simulated PLC stopped, every tag shows disconnected, the connection shows the agent's error, and the event "online → disconnected" is recorded.
  5. A viewer sees the values and history, and gets 404 for the other organization. Without a session the API answers 401.
  6. No password appears in any log.

## Notes
- **Float noise:** the agent sends scaled values as computed (24.700000000000003); they are stored as sent, and pages round them for display.
- **Session client ids:** with a persistent session, two Web Factory processes on one broker need different `WEB_FACTORY_MQTT_CLIENT_ID`s.

