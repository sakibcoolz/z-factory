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

## Implemented

### Authorization boundary (ADR-0007)
Every action and data-loading page calls `requireActor()` (`lib/auth/actor.ts`) and passes the `Actor` to the service layer. Factories of another owner are indistinguishable from missing ones (`NOT_FOUND`).

### `factories` (TASK-103)
Server actions in `app/factories/actions.ts`, services in `lib/services/factory-service.ts`. None of them creates a Docker network, starts a container or writes `runtimeStatus`.

| Operation | Entry point | Rules |
|---|---|---|
| list | `listFactories(db, actor)` | owner-scoped; includes device/PLC counts and the latest event |
| get | `getFactory(db, actor, id)` | `NOT_FOUND` for unknown or foreign ids |
| create | `createFactoryAction` → `createFactory` | validates name, slug and subnet; subnet must be private, canonical, /16–/28 and must not overlap any factory on the host; assigns `zfactory_<id>` as network name; status `DRAFT`, runtime `STOPPED`; records `FACTORY_CREATED` |
| update | `updateFactoryAction` → `updateFactory` | name, description, subnet; slug is fixed; the subnet changes only while `STOPPED` |
| delete | `deleteFactoryAction` → `deleteFactory` | only while `STOPPED`; cascades factory-owned rows, never catalog rows |

Form actions return `{ message?, fieldErrors, values }` on failure and redirect on success. Failures are typed `DomainError`s (`VALIDATION`, `UNAUTHORIZED`, `NOT_FOUND`, `CONFLICT`, …); unexpected errors are logged on the server and reach the browser only as a generic message.
