# TASK-902 — MQTT Broker Integration, Agent Onboarding & Connectivity

Status: **TODO**

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Connect Web Factory and Z-Factory Thin Client Agents through secure MQTT with explicit agent identity, topic authorization, heartbeat/state handling and reconnect semantics.

## Scope
- Server-side MQTT consumer/publisher in Web Factory.
- Topic contract for telemetry, state, heartbeat, command and acknowledgement.
- Agent registration/onboarding with stable siteId/agentId identity.
- TLS/mTLS or approved token/certificate authentication.
- Per-agent topic authorization and isolation.
- Heartbeat, last-seen and ONLINE/DEGRADED/OFFLINE projection.
- Duplicate/replayed message tolerance using message/event ids.
- Broker reconnect/backoff and observability.
- No browser MQTT broker credentials.

## Acceptance criteria
- A registered Thin Client Agent securely connects and publishes heartbeat/state.
- Web Factory projects online/offline/degraded state with last-seen timestamps.
- Unauthorized topic access is rejected.
- Broker disconnect/reconnect does not corrupt identity or duplicate durable state.
- MQTT connection health is observable.
