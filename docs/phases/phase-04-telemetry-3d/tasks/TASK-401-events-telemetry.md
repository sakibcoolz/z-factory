# TASK-401 — Events & Live Telemetry

Status: **DONE**
Linear: [ZFA-16](https://linear.app/recruit-verse/issue/ZFA-16)

## Objective
Implement internal domain/runtime events, selected persistence, alarms and live browser delivery without making PostgreSQL the live-state authority.

## Acceptance criteria
- Versioned event envelope.
- SSE as initial server-to-browser transport.
- Reconnect/last-event strategy.
- PLC tag, VFD, motor, pump, valve, sensor, gateway and fault events supported.
- Live values include quality and timestamp.
- Lifecycle/command/fault/alarm/audit events persisted.
- High-frequency telemetry uses sampling/change-threshold/retention strategy.
- DeviceRuntimeSnapshot is treated as snapshot, not control truth.
- Tests cover event ordering and important state transitions.

## Evidence (2026-10-05)
- **Versioned event envelope.** One envelope (`version: 1`) for every runtime event, recorded through one path that assigns id and time. Details: `docs/events-telemetry.md` → Implementation (TASK-401).
- **SSE transport.** `GET /factories/[factoryId]/stream`. In a browser on a production build the Live Tags and Events screens updated without a reload while another tab operated the factory; the response is not compressed or buffered.
- **Reconnect / last event.** Resuming after a known event returned exactly the five events recorded after it, in order, then the current state; an unknown id returned `reset`. Events recorded while a client connects arrive once. A hidden tab closes its stream and resumes from the last event it saw.
- **PLC tag, device, gateway and fault events.** Tag values of a real OpenPLC runtime are read and streamed. Device state and fault events of the simulator, PLC lifecycle and program events, and command events (accepted, failed, refused, received from a gateway source) are recorded and delivered. The gateway itself is Phase 05; its command path and event exist.
- **Quality and timestamp.** Every reading carries `quality` and `readAt`. Stopping the PLC turned all six tags of the open Live Tags page to DISCONNECTED; unconfirmed values turn STALE with their age; a PLC that is not started has no values.
- **Lifecycle, command, fault, alarm and audit events persisted.** All are `RuntimeEvent` rows; alarms are `AlarmEvent` rows with beginning, end and acknowledgement; who acknowledged and every refused write are kept.
- **Sampling, change threshold, retention.** On the real runtime, about twenty read cycles stored two to four samples per changed tag and one per unchanged tag. Deadband, minimum and maximum interval and retention are configurable and unit-tested.
- **Snapshot is not control truth.** A simulated device stored as "running" with a snapshot, but with no simulation running, is reported stopped and stale and the stored state is corrected; while a simulation runs its memory wins over a contradicting snapshot (tested).
- **Event ordering and state transitions tested.** Twenty concurrent recorders yield one order shared by database, ids and bus; alarm transitions, monitor transitions (answering, one missed answer, gone, back), stream order on connect and reconnect, and stop/start of monitoring are covered.
- Tests added: 77 (19 event, id, bus, alarm-rule and live-value rules; 13 monitor and sampling; 12 components; 10 events and alarms, 11 live service and 6 stream route and actions against PostgreSQL; 5 on a real OpenPLC runtime; 1 environment). 613 tests pass with database and Docker tests enabled; format check, lint, typecheck and build pass.

## Defects found and fixed while building this
- **Background tabs could block the application.** A browser allows about six connections to one server and every live page holds one; with six pages open, a button press never reached the server. A hidden tab now closes its stream.
- **A PLC being stopped was reported as a lost connection**, with an alarm. Its tags are no longer read before it is stopped, and its state is `STOPPING` meanwhile.
- **Monitoring could be started again after it was stopped**, when two passes overlapped and one had read the state before the stop. Passes now run one at a time per factory.
- **A program deploy raised a brief "PLC does not answer" alarm.** The connection counts as lost only when the PLC misses two attempts in a row.

## Decisions made in this task
- **ADR-0011 (accepted):** tag monitor in the server process, one ordered recording path, SSE with replay then snapshot.
- **Tag values are not recorded as events.** They are streamed and sampled; recording each change would make the event history unusable.
- **Stale is decided where a value is shown**, from its read time and the state of the stream.
- **Alarms come from four fixed rules**, including a BOOL tag with role `ALARM` set by the PLC program, so PLC logic can raise alarms without Z-Factory deciding for it.
- **No schema change.** The existing event, alarm and telemetry tables are used as they are.
- **Operator writes from Live Tags** use the existing tag write: only command and setpoint tags, recorded, with PLC logic deciding the effect.

## Not in this task
- Per-tag telemetry and alarm settings (deadband, severity, message): they need schema fields.
- A trend view of stored telemetry.
- Container logs in the browser.
- Streaming the simulator's analogue device values: the Simulator screen still polls every 2 s.
- More than one server process (ADR-0011).
- The gateway (Phase 05) and the 3D view (TASK-402, TASK-404).
