# TASK-904 — Web Factory Live Monitoring, Dashboards, Events & Alarms

Status: **TODO**

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
