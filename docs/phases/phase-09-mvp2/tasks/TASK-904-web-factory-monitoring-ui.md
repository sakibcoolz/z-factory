# TASK-904 — Web Factory Live Monitoring, Dashboards, Events & Alarms

Status: **DONE**
Linear: [ZFA-47](https://linear.app/recruit-verse/issue/ZFA-47)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Provide the cloud monitoring UI for users to understand factories, edge agents, PLCs, modules, tags, telemetry, alarms and connectivity in real time and historically.

## Scope
- Site/factory/agent/PLC/module hierarchy navigation.
- Agent and PLC connectivity/last-seen/quality views.
- Live tag values and telemetry charts.
- Alarm/event list with severity, source, timestamp and acknowledgement where allowed.
- Historical telemetry/time-range queries.
- SSE/WebSocket or equivalent server-to-browser live updates.
- Clear stale/disconnected indication; never show unknown data as healthy.
- Authorization applied to every cloud view/API.
- Responsive operational UI focused on monitoring rather than engineering configuration.

## Acceptance criteria
- Users can navigate from site -> agent -> PLC/module -> tag/telemetry.
- Live updates appear without page refresh.
- Historical telemetry and alarm/event history are queryable.
- Offline/stale states are visually explicit.
- Viewer/operator/admin permissions are enforced.

## Decisions (owner, 2026-10-07)
- **Alarm sources:**
  - PLC tags with role ALARM (HIGH), with the PLC program deciding;
  - a PLC disconnected (HIGH);
  - an agent offline or degraded (MEDIUM).

  No threshold rules are configured in the cloud.
- **Charts:** built-in SVG, with no chart library.
- **Acknowledgement:** operators and admins.

Recorded in ADR-0021.

## As built
Design: `docs/web-factory.md` → Monitoring and alarms.
- **Navigation:** organization → site → factory → module, and site → agent → PLC → tag, with breadcrumbs and links in both directions. New pages: `/factories/{id}`, `/modules/{id}`, `/plcs/{id}/tags/{tag}`, `/orgs/{id}/alarms`.
- **Live updates:** `GET /api/v1/live?scope=plc:|agent:|site:|org:<id>` (SSE).
  - The view is built from the database every 1.5 s, checked against the actor, and sent when it changed; the session is re-checked every 15 s.
  - Client components (`components/live*.tsx`) show *live* or *reconnecting*.
  - Org, site, agent, PLC, tag and alarm pages update without a refresh.
- **Charts** (`components/telemetry-chart.tsx`): built-in SVG, 15 min to 30 days in at most about 300 buckets. Numbers show the average with a min/max band; booleans a step line. Poor-quality buckets are shaded and gaps break the line; the two short ranges refresh every 5 s.
- **Alarms** (`lib/domain/alarms.ts`, `lib/alarms/engine.ts`, `lib/services/alarm-service.ts`):
  - a sweep every 3 s raises, clears and updates alarms;
  - `Alarm.activeKey` keeps one active alarm per condition, so concurrent sweeps are safe;
  - connection alarms are judged only after Web Factory has been on the broker for 2.5 heartbeat intervals;
  - an alarm tag stays raised while its last value was true, whatever its quality.
- **Acknowledgement:** operators and admins, once, audited as `ALARM_ACKNOWLEDGED`. The active list keeps an alarm until it is cleared and acknowledged; the history covers 24 h, 7 or 30 days. `GET /api/v1/alarms` returns the same lists.
- **Unknown is never healthy:**
  - values are projected STALE or DISCONNECTED, with pills;
  - agents are UNKNOWN or OFFLINE until heard from live;
  - a banner appears while Web Factory is off the broker.
- **Permissions:** every view and API checks membership, and another tenant's data is a 404. Viewers see everything but cannot acknowledge.
- **Data:** migration `alarms`.

## Acceptance criteria — evidence
- **Navigation from site to agent to PLC or module to tag:** the browser check followed site → agent, site → factory → module → PLC, and PLC → tag. Factory and module reads are tenant-scoped (database tests).
- **Live updates without refresh:**
  - in the browser, on one open PLC page, Speed_SP went 29.4 → 33.7 → 34.8 Hz;
  - the open alarms page went from 0 to 1 active when the PLC raised its alarm;
  - the open PLC page showed the PLC disconnected and its connection alarm;
  - the SSE route test receives a new view when a value is written.
- **Telemetry and alarm/event history queryable:** the tag page's chart and last samples, the PLC events, the alarm history (24 h, 7 or 30 days), and `/api/v1/alarms` (history by range and PLC, tested).
- **Offline and stale states explicit:**
  - a stopped PLC shows every value as *disconnected*, the PLC connection as such, and a HIGH alarm;
  - the Overheat alarm stays active while its last value was true;
  - unit tests cover unknown never being shown as healthy.
- **Permissions enforced:**
  - a viewer sees alarms but has no Acknowledge button, and the service refuses them (FORBIDDEN);
  - an operator acknowledges, once, audited;
  - another organization gets NOT_FOUND from every scope, list and stream (404).

## Evidence
- `npm test` in `apps/web-factory` passes: 13 files, 75 tests, with Docker and the real agent.
- Root project: prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` (with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`) passes: 97 files, 1034 tests.
- The app's lint, typecheck, prettier and `next build` are clean.
- **Browser check:** headless Chromium, `next start` on 3211, against a temporary Mosquitto, a simulated Modbus PLC with an alarm coil, the real agent, and a temporary organization with an admin, an operator and a viewer in the dev database `web_factory`. The database was emptied again afterwards, including its day partitions.
  1. The PLC page is live: values change without a reload, and the badge says *live*.
  2. The tag page shows the live value, the chart (1 h, then 24 h), quality changes and the last samples.
  3. The site page lists live agents and the factory; the factory and module pages navigate to the PLC.
  4. With the alarms page open, the PLC's Overheat coil switched on, and the page showed it without a reload (0 → 1 active).
  5. The operator acknowledged it ("Olli Operator, 3 s ago"). The viewer saw the alarm with no Acknowledge button, and the org page summarised "1 high, 1 unacknowledged".
  6. With the PLC stopped and the page open, values turned *disconnected* and a HIGH "PLC connection" alarm appeared; the agent's *degraded* alarm followed.
  7. At 390 px wide, the PLC and alarms pages have no horizontal scroll.
  8. No password appears in any log; the server log has no error.

## Notes
- **Polling cost:** each open live page queries the database every 1.5 s, which suits the expected numbers of operators. A notification bus can replace it later without changing the browser side (ADR-0021).

