# Server API Contract

The MVP is one Next.js application. "API" refers to server actions and/or route handlers, not a separate backend service.

## Resource groups
- `factories`
- `catalog`
- `devices`
- `racks/modules`
- `tags`
- `connections`
- `runtime`
- `events/telemetry`

## Command examples
Create/update factory configuration, add/configure device, install module into slot, create connection, start/stop/restart factory/device, write tag, inject supported simulation fault.

## Query examples
List factories, get factory definition, browse catalog, get device inspector, read tag snapshot, get runtime state, get topology.

## Live channel
SSE is the default MVP server-to-browser event/telemetry transport. Command writes use normal authenticated server endpoints/actions.

Every mutation must validate authorization plus domain invariants before invoking Docker/protocol side effects.
