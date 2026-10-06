# TASK-903 — Telemetry Ingestion, Cloud Persistence & Latest-State Projection

Status: **TODO**

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
