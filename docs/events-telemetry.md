# Events and Telemetry

## Internal events
Examples:
- FACTORY_CREATED
- FACTORY_START_REQUESTED
- FACTORY_STARTED
- FACTORY_STOPPED
- DEVICE_CREATED
- DEVICE_STARTING
- DEVICE_RUNNING
- DEVICE_FAULTED
- CONTAINER_EXITED
- TAG_VALUE_CHANGED
- MODBUS_READ
- MODBUS_WRITE
- CONNECTION_UP
- CONNECTION_DOWN
- FAULT_INJECTED

## Event envelope
```json
{
  "version": 1,
  "id": "uuid",
  "type": "DEVICE_RUNNING",
  "factoryId": "uuid",
  "deviceId": "uuid",
  "occurredAt": "ISO-8601",
  "payload": {}
}
```

## UI delivery
Start with SSE for server -> browser live updates unless bidirectional low-latency interaction requires WebSockets. Commands continue through normal server actions/route handlers.

## Persistence
Persist important lifecycle/fault/audit events. High-frequency telemetry should have retention/downsampling rules rather than unbounded relational writes.
