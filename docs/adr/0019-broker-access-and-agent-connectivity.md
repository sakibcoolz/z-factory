# ADR-0019 — Broker Access and Agent Connectivity

Status: **ACCEPTED** (TASK-902, 2026-10-07). Amended by ADR-0020: Web Factory's broker session is now persistent, with a stable client id, instead of clean.

## Context
Z-Factory Thin Client Agents publish telemetry, PLC state, a heartbeat and an online/offline status to an MQTT broker, and receive commands from it (ADR-0017). Web Factory (ADR-0018) must consume these on the server and show which agents and PLCs are connected. Many agents of many organizations share one broker, so no agent may read or write another agent's topics, and an administrator must be able to cut an agent off. The agent already supports a user name, a password file, TLS and client certificates.

## Decision
1. **Broker:** Mosquitto 2 (`eclipse-mosquitto:2`) with its **Dynamic Security** plugin, configured by `apps/web-factory/broker/mosquitto.conf`. Every client signs in (`allow_anonymous false`). The default rule denies publishing and subscribing. Packets are limited to 2 MiB.
2. **One broker client per agent, created by Web Factory.** When an admin issues an agent's credentials, Web Factory sends Dynamic Security commands over its own broker connection (`$CONTROL/dynamic-security/v1`):
   - **User name:** `agent:{siteKey}:{agentKey}`. A `:` cannot appear in either id, so names never collide.
   - **Client id:** the client is bound to the agent's default client id, `zfactory-agent-{siteKey}-{agentKey}`. Web Factory refuses to issue credentials when another agent derives the same client id.
   - **Role:** `zfactory-agent:{siteKey}:{agentKey}`, which allows only:
     - publishing to `…/telemetry/+`, `…/state/+`, `…/ack/+`, `…/agent/heartbeat` and `…/agent/status` (also the will);
     - subscribing to `…/command/+`.
   - **Password:** 24 random bytes, shown once to the admin who issued it. Web Factory never stores or logs it; the broker keeps only its hash.
   - **Re-issuing:** replaces the password and disconnects the agent (rotation). Every step can be repeated safely.
   - **Revoking:** disables the client, which disconnects it and refuses its sign-in. Web Factory then also drops anything that still arrives for that agent.
   - **Broker first:** when the broker cannot be reached, nothing changes in Web Factory.
3. **Web Factory's broker connection is server-only:** one MQTT 5 connection per server process, started by `instrumentation.ts`.
   - It starts a clean session and subscribes to what agents publish (`zfactory/+/+/agent/+`, `…/state/+`, `…/telemetry/+`, `…/ack/+`).
   - Reconnect delays start at 1 s and double up to 30 s; a successful connect resets them.
   - Its account needs the `dynsec-admin` role and read access to `zfactory/#`. The `admin` client that `MOSQUITTO_DYNSEC_PASSWORD` creates has both.
   - Browsers only ever see projected state from the database.
4. **Connectivity is projected, not stored** (`lib/domain/connectivity.ts`):
   - **What is stored:** what the agent last reported (status, heartbeat counters, each PLC worker's state) and when Web Factory last heard from it live.
   - **UNKNOWN:** never heard from.
   - **OFFLINE:** the agent reported offline (or its will did), its credentials were revoked, or it was silent for 6 heartbeat intervals.
   - **DEGRADED:** silent for 2.5 intervals, a PLC worker not online, or telemetry waiting in the agent's spool.
   - **ONLINE:** otherwise.
   - Time comes from Web Factory's clock, never the agent's.
5. **Replay and duplicate tolerance without message ids.** The agent's status, heartbeat and state messages carry no id, so the ingestor:
   - **order:** applies each agent's messages one at a time, in delivery order;
   - **in place:** updates rows rather than adding them;
   - **events:** records a connection event only when the reported status changes, timed by Web Factory. Agents build their will once, at start, so its `at` is older than the online report before it; ordering by the agent's time would drop every will.
   - **retained:** treats retained messages as the broker's latest word, never as a sign of life;
   - **checks:** drops a message whose body names another agent than its topic, or that comes from an unregistered or revoked agent.

## Consequences
- **Single broker:** agents of every organization share it. Isolation rests on the per-agent roles, with Web Factory's checks of topic and identity as a second line.
- **Transport security:** the Dynamic Security commands carry passwords in clear, so in production the broker connection must be TLS (`mqtts://`), for Web Factory and agents alike. Development and tests bind the broker to loopback.
- **Web Factory's account:** it is a broker administrator. A production deployment may give it a narrower client holding only `dynsec-admin` plus its topic role.
- **Rotation:** a running agent keeps its old password until restarted with the new file, and is refused until then.
- **Not built:** mTLS client certificates and a certificate authority are not part of this decision; they would need a new one.
