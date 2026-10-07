# ADR-0020 — Telemetry Storage, Idempotency and Latest State

Status: **ACCEPTED** (TASK-903, 2026-10-07)

## Context
Every Thin Client Agent publishes one telemetry batch per poll of each PLC: all its tags, with a value and a GOOD or BAD quality, under one poll time. Web Factory must keep this history, answer per-tag queries, keep the latest value of every tag, and record what changed. It must also:
- survive redelivery and the agent's replay of spooled batches without duplicates;
- stay bounded under load;
- leave room for a dedicated time-series engine later.

Batches carry no message id.

## Decision
1. **Storage, chosen by the owner:** one row per tag per poll, in PostgreSQL.
   - The history lives in a schema of its own, `telemetry`, outside the Prisma schema. Prisma neither models nor diffs it, so it cannot cause migration drift.
   - `telemetry.batch` (one row per poll, keyed `(plc_id, at)`) and `telemetry.sample` (keyed `(plc_id, tag, at)`) are range-partitioned by UTC day.
   - Web Factory creates a day's partitions when a batch of that day first arrives, and today's and tomorrow's ahead (`maintain`, at start and hourly).
2. **Retention, chosen by the owner:** 30 days by default (`WEB_FACTORY_TELEMETRY_RETENTION_DAYS`).
   - Partitions older than the retention are dropped whole, with no `DELETE`.
   - A batch older than the retention is refused, as is one more than 10 minutes in the future (a wrong clock).
3. **Idempotency without message ids:** a batch's identity is its PLC and its poll time. The agent stamps every value of one poll with the same time, and a replayed batch keeps it.
   - Inserting into `telemetry.batch` with `ON CONFLICT DO NOTHING` tells new batches from duplicates.
   - Only new batches add samples, latest values and events.
4. **Tags by external id:** history and latest values are keyed by the tag's external id (`PlcMapping.externalId`). It survives a new registration, which recreates the mapping rows.
5. **Latest state is deterministic** (`TagLatest`, `advanceLatest`):
   - A value replaces a tag's latest value only if its poll time is newer, so arrival order does not matter.
   - Within one write, the latest rows are locked and walked in time order.
   - The stored quality is what the agent sent. STALE (not refreshed for 3 poll intervals, the agent's rule) and DISCONNECTED (the PLC's reported connection is not up, or its agent is unreachable) are projected when read, never stored.
6. **Events** (`PlcEvent`), recorded once each by a unique key on (PLC, kind, subject, the agent's time):
   - a tag's quality change, recorded as the latest view advances;
   - a change of the PLC's reported connection state.

   Alarm rules and acknowledgement are TASK-904, chosen by the owner.
7. **Bounded ingestion:** the MQTT handler validates a batch and offers it to a pipeline; it never waits for the database.
   - The pipeline has a fixed number of writers (default 2). Each has a queue of `capacity / writers` batches (capacity 10,000 by default); when a queue is full, its oldest batch is dropped and counted.
   - A PLC always goes to the same writer, so its batches are stored in arrival order.
   - A writer stores up to 200 batches per transaction, with `unnest` bulk inserts.
   - Counters cover offered, queued, stored, duplicates, samples, events, unknown tags, version mismatches, errors, drops by reason, and the last write time. They appear in the `broker stats` log line, and `/api/ready` reports `telemetry: backlogged` above 80 % of the queue.
8. **Web Factory's broker session is persistent:** a stable client id, `clean: false`, and a session expiry of 1 day.
   - While Web Factory is away, the broker queues what agents publish with QoS 1, up to 100,000 messages and 256 MiB per client (`broker/mosquitto.conf`). This includes what an agent replays from its spool.
   - Before this, a reconnecting agent could replay its spool before Web Factory was back, and those batches were lost. The end-to-end test showed it.
9. **Access through an interface:** the pipeline and the queries use `TelemetryStore` (write, history, aggregate, maintain), so a dedicated time-series engine can replace the history without touching ingestion or the API.

## Consequences
- **Volume:** one row per tag per poll. At a 1 s poll, 100 PLCs of 100 tags make 10,000 rows per second. A development machine stored about 140,000 samples per second (20 PLCs × 50 tags × 100 polls in 0.7 s). Beyond that, the interface allows another engine.
- **Queries:** history is per tag (raw, or bucketed with min/max/avg/last and the worst quality), limited to 31 days and 10,000 points.
- **Late data:** a replayed older batch fills the history but does not move the latest value. Quality changes are recorded only as the latest view advances, so a replay of the past adds no events.
- **Client ids:** two Web Factory processes on one broker need different client ids (`WEB_FACTORY_MQTT_CLIENT_ID`; by default `web-factory-<host>`). Otherwise they take over each other's session.
- **Overload:** batches dropped for overload are lost to the history, and are counted.
