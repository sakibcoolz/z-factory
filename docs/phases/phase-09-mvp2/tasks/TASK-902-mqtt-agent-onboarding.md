# TASK-902 — MQTT Broker Integration, Agent Onboarding & Connectivity

Status: **DONE**
Linear: [ZFA-45](https://linear.app/recruit-verse/issue/ZFA-45)

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

## Decisions (owner, 2026-10-07)
- **Broker access:** Mosquitto Dynamic Security, one client and role per agent, with a generated password shown once.
- **Client library:** MQTT.js (`mqtt`) in Web Factory, server-side only.

Recorded in ADR-0019.

## As built
Design: `docs/web-factory.md` → Broker and agent onboarding, Connectivity.
- **Broker:** `apps/web-factory/broker/mosquitto.conf`: Mosquitto 2, no anonymous access, Dynamic Security with deny-by-default, 2 MiB packets. TLS is required outside development (ADR-0019).
- **Onboarding** (`lib/services/onboarding-service.ts`, `lib/mqtt/dynsec.ts`): an admin issues an agent its broker client:
  - user name `agent:{site}:{agent}`, bound to client id `zfactory-agent-{site}-{agent}`;
  - a role for its own topics only: publish telemetry, state, ack, heartbeat and status; subscribe to commands.
  - The password is shown once, with the agent's settings, and never stored, logged or audited.
  - Re-issuing rotates it and disconnects the agent; revoking disables the client.
  - The broker goes first, so nothing changes when it is down, and every step can be repeated.
  - A client id derived by two agents is refused. Each action is audited.
- **Web Factory's connection** (`lib/mqtt/runtime.ts`, `lib/mqtt/boundary.ts`, `instrumentation.ts`): one MQTT 5 connection per server process, started with the server.
  - It subscribes to every agent's status, heartbeat, state, telemetry and ack topics.
  - Reconnect delays grow from 1 s to 30 s; a refused subscription is reported.
  - Status: logs on connect and loss, a `broker stats` line every minute, `mqtt` in `/api/ready`, a broker card for admins, and a banner on pages while disconnected.
- **Ingestion** (`lib/mqtt/ingest.ts`), per agent and in delivery order:
  - **Status:** a change of status is recorded once as a connection event, timed by Web Factory, so the will's old timestamp does not matter.
  - **Heartbeat:** stored and coalesced; it marks the agent online.
  - **PLC state:** stored per registered PLC; an empty retained message marks it REMOVED.
  - **Telemetry and acks:** they refresh last-seen at most every 5 s.
  - **Retained messages:** applied, never counted as a sign of life.
  - **Drops,** counted by reason: wrong topic, body naming another agent, unregistered agent or PLC, revoked, malformed, too large.
- **Projection** (`lib/domain/connectivity.ts`): UNKNOWN, ONLINE, DEGRADED (late heartbeat, a PLC worker not online, telemetry spooled) or OFFLINE (reported, revoked, or silent for 6 heartbeat intervals), with reasons. A PLC shows its worker's reported state while its agent is reachable.
- **Data:** migration `agent_connectivity`. EdgeAgent gains status time, heartbeat, version and broker client fields. Plc gains its reported `edge…` state. New: AgentConnectionEvent.
- **Screens:** org (agents per state, broker card), site (connectivity, last seen), agent (status with reasons, heartbeat, PLC connection and last poll, history, credentials), PLC (reported connection).
- **Contract:** `lib/domain/agent-messages.ts` is Web Factory's own copy of the agent's topics and messages. The agent needed no change.
- **CI:** the app's tests run with Docker and the agent binary.

## Acceptance criteria — evidence
- **Secure connect, heartbeat and state:** `test/broker.test.ts` onboards an agent against a real Mosquitto with Dynamic Security. The real Go agent then connects with the issued credentials and shows online with heartbeats. A wrong password or client id is refused.
- **Online, offline, degraded with last-seen:** unit tests cover every state. The database and broker tests show online from status and heartbeat, degraded from a PLC worker and silence, offline from silence, the will, SIGTERM and revocation, each with last-seen.
- **Unauthorized topics rejected:** the agent publishing to another agent's status or to its own command topic, or subscribing to another agent's commands, `zfactory/#` or the control topic, gets reason 135. Web Factory receives nothing.
- **Reconnect without corrupting identity or duplicating state:**
  - after Web Factory reconnects, the retained replay adds no connection event and leaves last-seen unchanged;
  - after a broker restart, Web Factory and the agent sign in again with the same client;
  - redelivered and retained copies of a status add nothing;
  - ingest errors stay 0.
- **Connection health observable:** `/api/ready` reports `mqtt`; logs and a `broker stats` line; the admin broker card; the disconnected banner. All were seen in the browser.

## Evidence
- `npm test` in `apps/web-factory` passes: 8 files, 45 tests. That includes `test/broker.test.ts` with Docker and the real agent: 8 tests, repeated 4 times, every container removed.
- Root project: prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` (with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`) passes: 97 files, 1034 tests.
- Lint, typecheck, prettier and `next build` of the app are clean. No MQTT code or setting is in the browser bundles (`.next/static`).
- **Browser check:** headless Chromium; `next start` on 3211 against a temporary Mosquitto and a temporary organization in the dev database `web_factory`, which was empty before and emptied again afterwards. The real agent was used throughout.
  1. `/api/ready` reports `mqtt: connected` from start-up. The agent shows "not heard from yet".
  2. The admin issues credentials. The password (32 characters) and the agent's settings are shown once, then gone after a reload. No password appears in any log.
  3. The agent connects with them and shows online with its heartbeat. With a PLC staged at an unreachable host, it shows degraded ("1 of 1 PLC workers not online"), and the PLC row shows the agent's "disconnected: dial tcp … i/o timeout". The site and org pages agree.
  4. Killed with SIGKILL, the agent shows offline from its will within 2 s. The PLC shows "unknown, last reported reconnecting" and the history shows online, then offline.
  5. A viewer sees status but no credentials section or broker card.
  6. Issuing a new password disconnects the running agent, and the broker refuses its old password ("not authorised"). With the new password it is back online.
  7. Revoking disconnects the agent and refuses it again; the page shows offline, "its broker credentials are revoked".
  8. With the broker stopped, `/api/ready` reports `disconnected` and the pages show the banner with a growing retry delay. When it returns, Web Factory reconnects (1 reconnect on the broker card).

## Notes
- **npm audit:** MQTT.js adds no audit finding. The existing high findings are in `eslint-config-next` (`braces`) and Prisma tooling (`deepmerge-ts`); their only "fix" downgrades those packages.
- **Not stored here:** telemetry and command acknowledgements only refresh last-seen; storing them is TASK-903 and TASK-905.

