# ADR-0021 — Monitoring: Alarms and Live Updates

Status: **ACCEPTED** (TASK-904, 2026-10-07)

## Context
Web Factory's monitoring screens must:
- show agents, PLCs and tag values as they change, without a page refresh;
- raise alarms with a severity, source and time, and let them be acknowledged;
- never show unknown data as healthy.

Agents publish no alarms of their own. Z-Factory tags carry a role, and the PLC program raises its alarms on tags with role `ALARM`.

## Decision
1. **Alarm sources, owner decision:**
   - a PLC tag with role ALARM that reads true (HIGH);
   - a PLC whose reported connection is DISCONNECTED or RECONNECTING while its agent is reachable (HIGH);
   - an agent that is offline or degraded (MEDIUM).

   No threshold rule is configured in the cloud: the PLC program judges values.
2. **Unknown is never healthy:**
   - An alarm tag's alarm stays while its last value was true, whatever its quality now, and clears only on a false value.
   - When an agent is unreachable, its own alarm replaces one alarm per PLC.
   - An agent never heard from, or with revoked credentials, raises nothing.
3. **One sweep raises and clears** (`lib/alarms/engine.ts`, every 3 s). It compares the alarms that should be active (`lib/domain/alarms.ts`, pure) with those that are:
   - it raises what is missing, clears what ended, and updates a changed message;
   - `Alarm.activeKey`, unique and null once cleared, keeps one active alarm per condition, so sweeps may run in several processes at once;
   - connection alarms are judged only after Web Factory has been connected to the broker for 2.5 heartbeat intervals. Otherwise every agent looks silent, and a Web Factory outage would raise an alarm per agent.
4. **Acknowledgement, owner decision:** operators and admins (the `command` permission), once per alarm, audited as `ALARM_ACKNOWLEDGED`. An alarm stays on the active list until it is both cleared and acknowledged.
5. **Live updates are server-sent events:** `GET /api/v1/live?scope=plc:|agent:|site:|org:<id>`.
   - Every 1.5 s the stream builds the scope's view from the database (`lib/services/live-service.ts`) with the same membership checks as every page, and sends it when it changed.
   - Built from the database, the view is the same whichever Web Factory process serves the browser; no cross-process bus is needed.
   - The session is checked again every 15 s, so a disabled user's stream ends.
   - The browser's EventSource reconnects by itself, and pages say whether they are live.
6. **Charts are built-in SVG, owner decision:** no chart library. A tag's history is fetched in at most about 300 buckets.
   - Numbers: the average with a min/max band. Booleans: a step line.
   - Buckets whose worst quality was not GOOD are shaded, and gaps break the line.
7. **Navigation:** organization → site → (factory → module →) agent → PLC → tag. Each page loads its data on the server, and the live parts update in client components that import no server module.

## Consequences
- **Polling cost:** each open live page queries the database every 1.5 s. That suits the expected numbers of operators; a notification bus can replace polling later without changing the browser side.
- **Alarm latency:** up to the sweep interval (3 s) plus a stream tick (1.5 s).
- **Not built:** alarm thresholds, shelving and escalation would need a new decision.
