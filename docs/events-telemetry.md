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
