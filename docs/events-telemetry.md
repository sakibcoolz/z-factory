# Events and Telemetry

## State model
Live state belongs to OpenPLC/device-simulator memory. PostgreSQL stores durable configuration/history and selected state snapshots.

Do not persist every scan/simulation tick by default.

## Internal events
Examples:
- FACTORY_CREATED / STARTED / STOPPED
- DEVICE_CREATED / STARTING / RUNNING / STOPPED / FAULTED
- CONTAINER_EXITED
- PLC_PROGRAM_DEPLOYED / PLC_PROGRAM_DEPLOY_FAILED
- DEVICE_STATE_CHANGED
- PLC_TAG_UPDATED
- PLC_FEEDBACK_UPDATED
- MODBUS_READ / MODBUS_WRITE
- GATEWAY_COMMAND_RECEIVED
- VFD_COMMAND_CHANGED / VFD_STATE_CHANGED
- MOTOR_STATE_CHANGED
- PUMP_STATE_CHANGED
- VALVE_STATE_CHANGED
- SENSOR_VALUE_CHANGED
- CONNECTION_UP / CONNECTION_DOWN
- FAULT_INJECTED / FAULT_CLEARED
- ALARM_RAISED / ALARM_ACKNOWLEDGED / ALARM_CLEARED
- PLC_LINK_CHANGED (family LINK; a PLC-to-PLC link or one of its mappings created, changed or removed, with the link's version)
- CONNECTION_DOWN / CONNECTION_UP with `link: plc-link` (TASK-703): a PLC-to-PLC link's quality changed; `deviceId` is the client PLC, `to` the server, `state` the new quality (`STALE`, `DISCONNECTED`, `GOOD`) and `message` the reason. They raise no alarm.
- PROCESS_OVERRIDE_SET / PROCESS_OVERRIDE_CLEARED (family PROCESS, TASK-801): a test put a value the PLC reads into MANUAL_OVERRIDE or SCENARIO, or back to AUTO; with `module`, `code` (signal), `mode`, `value` or `profile`, and `by`
- PROCESS_BRIDGE_STARTED / PROCESS_BRIDGE_STOPPED
- PROCESS_STATE_CHANGED / PROCESS_QUALITY_CHANGED (family PROCESS)
- PROCESS_ALARM_RAISED / PROCESS_ALARM_CLEARED

## Event envelope
```json
{
  "version": 1,
  "id": "uuid",
  "type": "VFD_STATE_CHANGED",
  "factoryId": "uuid",
  "deviceId": "uuid",
  "occurredAt": "ISO-8601",
  "payload": {}
}
```

## UI delivery
Start with SSE for server -> browser updates. Introduce WebSockets only when bidirectional low-latency behavior materially benefits the product. Commands still go through authenticated server endpoints/actions.

## Persistence rules
Always persist important lifecycle changes, commands, faults, alarms, acknowledgements and audit events.

Telemetry persistence is configurable by tag/device. Use sampling, change thresholds, retention and downsampling. A future TimescaleDB extension is optional; PostgreSQL remains the primary relational store.

## Quality
Live values should carry quality/state such as GOOD, STALE, BAD, DISCONNECTED and a timestamp so the UI can distinguish a valid value from an old one.

A process module in the bridge (TASK-603, docs/process-simulation.md → Bridge) carries `GOOD`, `STALE` (the simulation service could not advance the model; the values are from an earlier cycle) or `DISCONNECTED` (a PLC the module exchanges with does not answer; its commands count as de-energized). Changes are recorded as `PROCESS_QUALITY_CHANGED` with `module`, `from`, `to` and the cause.

### Process alarms (TASK-603)
An ALARM signal of a process module that becomes active records `PROCESS_ALARM_RAISED` (`module`, `moduleId`, `code` = signal key, `name`) and raises the alarm `PROCESS:<module>/<signal>` without a device; it clears with `PROCESS_ALARM_CLEARED`, and `PROCESS_BRIDGE_STOPPED` clears every process alarm of the factory. The model's own `ALARM_*` events are not repeated; its other events (`PUMP_STARTED`, …) are recorded as `PROCESS_STATE_CHANGED` with `module`, `event`, `message`, `tick` and the model's values.

## Implementation (TASK-204)
- Envelope type: `lib/domain/events.ts`. In-process bus: `lib/events/bus.ts` (`getEventBus()`); it keeps no history. The SSE transport is not built yet.
- The device simulator emits: `SIMULATION_STARTED`, `SIMULATION_STOPPED`, `VFD_STATE_CHANGED`, `MOTOR_STATE_CHANGED`, `PUMP_STATE_CHANGED`, `VALVE_STATE_CHANGED`, `SENSOR_VALUE_CHANGED`, `DEVICE_STATE_CHANGED`, `FAULT_INJECTED`, `FAULT_CLEARED`, `DEVICE_RESET`, `SIMULATED_INPUT_FORCED`, `SIMULATED_INPUT_RELEASED`, `CONNECTION_UP`, `CONNECTION_DOWN` (PLC link of the simulator; `deviceId` is the PLC).
- State-change payload: `{ from, to, outputs }`. Fault payload: `{ code, name, latching, source }`.
- Every emitted event is stored as a `RuntimeEvent` and published on the bus. Events are emitted on state changes, faults, operator actions and link changes, never per tick. A sensor emits value events only when its `eventDeadband` is configured.
- Snapshots: one `DeviceRuntimeSnapshot` row per device, overwritten every `SIMULATION_SNAPSHOT_MS` and when the simulation stops.
- Superseded by TASK-401 below for how events are recorded: ids, order, alarms, telemetry and live delivery.

## Implementation (TASK-401, ADR-0011)
Code: `lib/services/event-service.ts` (recording, alarms, history, replay), `lib/services/live-service.ts` (monitoring, live views, stream), `lib/runtimes/tag-monitor/` (monitor, sampling rule), `lib/events/` (bus, ids, SSE encoding), `lib/domain/events.ts`, `lib/domain/alarms.ts`, `lib/domain/live.ts` (vocabulary and rules, pure).

### Recording
Every runtime event goes through `recordEvents`. It assigns the id and `occurredAt`, stores the event, applies the alarm rules, and publishes to the bus. Recording is serialized per server process; ids are UUID v7 and strictly increasing, so storage, id and publication order are the same. Envelope version: `1`.

Configuration events written inside a configuration transaction (`FACTORY_CREATED`, `DEVICE_CREATED`) are stored with the change and are not published live.

### Event types
| Family | Types |
|---|---|
| Lifecycle | `FACTORY_CREATED`, `DEVICE_CREATED`, `DEVICE_STARTING`, `DEVICE_RUNNING`, `DEVICE_STOPPED`, `SIMULATION_STARTED`, `SIMULATION_STOPPED` |
| Program | `PLC_PROGRAM_DEPLOYED`, `PLC_PROGRAM_DEPLOY_FAILED` |
| Device state | `VFD_STATE_CHANGED`, `MOTOR_STATE_CHANGED`, `PUMP_STATE_CHANGED`, `VALVE_STATE_CHANGED`, `SENSOR_VALUE_CHANGED`, `DEVICE_STATE_CHANGED`, `SIMULATED_INPUT_FORCED`, `SIMULATED_INPUT_RELEASED` |
| Faults | `DEVICE_FAULTED`, `FAULT_INJECTED`, `FAULT_CLEARED`, `DEVICE_RESET` |
| Alarms | `ALARM_RAISED`, `ALARM_ACKNOWLEDGED`, `ALARM_CLEARED` |
| Commands | `COMMAND_ACCEPTED`, `COMMAND_FAILED`, `COMMAND_REJECTED`, `GATEWAY_COMMAND_RECEIVED` |
| Connections | `CONNECTION_UP`, `CONNECTION_DOWN` (`payload.link`: `tag-monitor` or `device-simulator`), `GATEWAY_CLIENT_CONNECTED`, `GATEWAY_CLIENT_DISCONNECTED` (an edge device at a gateway endpoint; `deviceId` is the gateway, `payload.name` the device's address) |

A type the vocabulary does not know is shown in the family "Other", never dropped. State-change payloads carry `activeFaults` in addition to `from`, `to` and `outputs`.

Tag values are not events. `PLC_TAG_UPDATED` and `PLC_FEEDBACK_UPDATED` from the list above are delivered as `tags` messages on the stream instead of being recorded one by one; what is kept of them is telemetry.

### Commands
A write of a command or setpoint tag records `COMMAND_ACCEPTED` (the PLC took the value) or `COMMAND_FAILED`, next to its `DeviceCommand` row. A write to a tag that is not writable records `COMMAND_REJECTED` (warning) and reaches no PLC. A write with source `GATEWAY` records `GATEWAY_COMMAND_RECEIVED` first. Payload: `tag`, `value`, `source`, `commandId`.

Since TASK-501 gateway writes arrive through a gateway endpoint (`docs/gateway-modbus.md`). A write the endpoint refuses reaches no PLC and records `COMMAND_REJECTED` with `source` `GATEWAY`, `rule` (`gateway-unmapped`, `gateway-read-only`, `gateway-partial-value`), the Modbus `area`, `address` and `count`, and the `tag` when one is concerned; the same refusal is recorded at most once in 30 seconds. Reads are not events.

### Alarms
An alarm (`AlarmEvent`) begins and ends by these rules; one alarm per condition, however often it is reported.

| Condition | Raised by | Ended by | Code |
|---|---|---|---|
| Fault of a simulated device | `FAULT_INJECTED` | `FAULT_CLEARED`; for a latching fault, the device leaving its faulted state (operator reset or the PLC's reset signal); the simulation stopping | `FAULT:<code>` |
| PLC runtime failed | `DEVICE_FAULTED` | the runtime reported running, stopped, starting or any other state | `RUNTIME_FAULT` |
| PLC does not answer | `CONNECTION_DOWN` of the tag monitor, after two attempts in a row | `CONNECTION_UP` of the tag monitor; the PLC being stopped | `PLC_LINK_DOWN` |
| Alarm raised by PLC logic | a BOOL tag with role `ALARM` read as true | the tag read as false; the PLC being stopped | `TAG:<tag name>` |

Each beginning and end is recorded as `ALARM_RAISED` / `ALARM_CLEARED` right behind the event that caused it. `acknowledgeAlarm` records `ALARM_ACKNOWLEDGED` with who did it; acknowledging does not end an alarm. Severity comes from the fault or the event; an alarm tag is `WARNING`.

### Live tags
The tag monitor reads every PLC with a started runtime every `TAG_POLL_MS`. A reading is `{ plcId, name, value, quality, readAt }`.

| Quality | Meaning |
|---|---|
| `GOOD` | read from the PLC at `readAt` |
| `STALE` | good, but not confirmed for longer than the stale time (5 s, or four poll cycles if longer), or the browser's stream is interrupted. Decided where the value is shown |
| `BAD` | the PLC answered but refused the address range, or the value could not be decoded |
| `DISCONNECTED` | the PLC did not answer (the last value is kept), or the PLC is not monitored (no value) |

Feedback is only as good as what writes it (TASK-803, docs/device-simulation.md → Command bridge). A good read of a `SIMULATION_FEEDBACK` tag takes the quality of its writer: `STALE` while no simulation of the device runs or the process module's bridge is stopped or cannot advance the model, `DISCONNECTED` while that bridge cannot reach the PLC, `BAD` while the simulated sensor has lost its signal. The PLC may answer and still hold values nothing produces any more; the screen, the stream and the telemetry history say so instead of showing them as healthy. A change of writer quality alone is a change: it is published and sampled.

### Stream
`GET /factories/[factoryId]/stream`, `text/event-stream`, same authorization as the factory's screens (404 otherwise).

| SSE event | `id` | Data |
|---|---|---|
| `event` | the event id | the event envelope |
| `tags` | — | `{ kind, factoryId, plcId, at, confirmed, readings }`: changed readings of one PLC; `confirmed` means the PLC answered at `at`, so its other good values are that fresh |
| `devices` | — | `{ kind, factoryId, at, devices }`: the state of every device, sent about 120 ms after recorded events (one message for a burst). Worked out by the server from runtime memory, so a client never derives state from events (TASK-404) |
| `snapshot` | — | `{ kind, snapshot: { factoryId, at, tags, devices, activeAlarms } }` |
| `heartbeat` | — | `{ kind, at }`, every 15 s |
| `reset` | — | `{ kind, reason }`: missed events cannot be replayed (`UNKNOWN_EVENT`, `TOO_MANY_EVENTS`) |

On connect: the events after `Last-Event-ID` (or `?lastEventId=`), then `snapshot`, then live messages. Without an id: `snapshot`, then live. `retry` is 3 s. An unchanged PLC is confirmed about once a second.

A device in `snapshot.devices` and in a `devices` message has a `source`: `LIVE` (simulator memory), `SNAPSHOT` (the simulation is not running; `at` is when `DeviceRuntimeSnapshot` was taken and the status is stopped) or `STORED` (a PLC runtime's last stored state).

### Telemetry
For every monitored tag a `TelemetrySample` is stored when the value moved by at least the deadband since the last stored sample (`TELEMETRY_DEADBAND_PERCENT` of that value, never less than the tag's resolution: its scale, or 1 for a BOOL), not more often than `TELEMETRY_MIN_INTERVAL_MS`, at least every `TELEMETRY_MAX_INTERVAL_MS`, and whenever its quality changes. A BOOL is stored as 0 or 1.

Retention: samples older than `TELEMETRY_RETENTION_HOURS`, and events and cleared alarms older than `EVENT_RETENTION_DAYS`, are deleted (checked at most every ten minutes while a PLC is monitored). Active alarms are kept.

### Limits
- Nothing is read or recorded for a PLC while it is not monitored: before a live screen, a stream or a runtime operation has run after a server restart.
- Sampling and alarm settings are global; there is no per-tag deadband, severity or alarm message yet.
- No trend view reads the stored telemetry yet.
- Container logs are not part of the stream.
- One server process (see ADR-0011).
