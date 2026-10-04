# Server API Contract

The MVP is one Next.js application. "API" means authenticated server actions and/or route handlers, not a separate backend service.

## Resource groups
- `factories`
- `catalog`
- `devices`
- `racks/modules`
- `io-points`
- `tags`
- `connections`
- `programs/versions`
- `runtime`
- `simulation`
- `gateways/modbus`
- `events/alarms/telemetry`
- `exports`

## Commands
- create/update factory
- create/update/remove factory device instance
- install/remove module in rack slot
- connect/disconnect device endpoints
- assign/release PLC I/O point
- create/update tag/register mapping
- compile/deploy/run/stop/restart PLC program
- force permitted simulated input
- write permitted PLC command/setpoint tag
- start/stop/reset/fault-inject simulator devices
- configure gateway-to-PLC mapping
- start/stop/restart factory/device runtime
- generate PLC engineering export

## Queries
- list/get factories
- browse catalog and compatibility
- get device inspector
- list PLC pins/channels and occupancy
- list tags/register map
- read live tag snapshot
- get runtime/container health
- get topology/connections
- get alarms/events/history
- get export/version metadata

## Live channel
SSE is the default server-to-browser event/telemetry transport. WebSockets may be added when justified.

## Mutation invariant
Every mutation validates authorization plus domain invariants before Docker/protocol/runtime side effects. External gateway writes target PLC command/setpoint mappings and must not bypass PLC control logic.
