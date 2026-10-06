# Process Simulation Service

The process simulation service (`services/process-sim`, Go) is the ADR-0008 runtime for
process modules: a deterministic tick loop that hosts many module instances in one
process, behind a small JSON API that only the Z-Factory server talks to. It computes the
process response to what the PLC commands; the PLC stays the control authority. Built in
TASK-602; the bridge to PLC tags is TASK-603, the module designer TASK-604, the I/O
registry TASK-605.

## Boundaries
- **Additive.** Nothing of Phases 02–05 depends on it. The shared device simulator
  (ADR-0010) keeps simulating single devices; this service simulates coupled processes.
- **One service, many instances.** One container per installation, not one per module or
  device. The limit is `PROCESS_SIM_MAX_INSTANCES` (default 256).
- **Memory only.** Instances, state and recent events live in the service's memory. A
  restart starts empty; Z-Factory owns the configuration and loads it again. Nothing is
  persisted per tick anywhere (ADR-0008).
- **Internal and authenticated.** Every request but `GET /healthz` needs
  `Authorization: Bearer <PROCESS_SIM_TOKEN>`; the service refuses to start without a token
  of at least 16 characters. Only `lib/runtimes/process-sim/client.ts` (server-only) sends
  it; no page, route, action or component reaches the service (tested). The compose file
  binds the port to `127.0.0.1`.
- **Not a certification.** Models are deterministic control-test approximations
  (`docs/process-modules.md` → Fidelity).

## Determinism
A model is a pure function of its parameters, state, inputs and the fixed time step
`tickMs / 1000` seconds. The same configuration stepped the same number of times with the
same inputs gives byte-equal outputs and state, on any machine; models use no clock and no
randomness, and outputs are rounded to a fixed precision. Simulated time is the tick count
times the tick, never the wall clock.

Two clocks: `wall` ticks on its own at `tickMs` while the instance is RUNNING (a tick missed
under load is not caught up); `manual` advances only when stepped. Either can be stepped by
`POST …/step?ticks=n`, which is how tests and the bridge reach a state without waiting.

## Lifecycle
`LOADED → RUNNING ↔ STOPPED`, and `RUNNING | STOPPED → LOADED` by reset.

| Operation | Effect |
|---|---|
| load (`PUT /v1/instances/{id}`) | validates the configuration and stores the instance as `LOADED` at tick 0 with its initial inputs; an existing instance of the id is replaced |
| start | `RUNNING`; a wall-clock instance begins ticking; from `STOPPED` it continues where it stopped |
| stop | `STOPPED`, state kept |
| reset | the model back to the initial state of its configuration: tick 0, configured inputs, no outputs; the events are kept and a `RESET` event is recorded |
| step | advances a `RUNNING` instance by n ticks (1–100000) at once |
| inputs (`PUT …/inputs`) | replaces the given inputs; others keep their value; unknown names are refused |
| inspect / list / events (`?after=seq`) | the snapshot, every snapshot, the last 200 events |
| unload (`DELETE`) | stops and forgets the instance |
| restart of the service | every instance is gone; Z-Factory reloads what it owns |

`FAULTED` is reserved for a model that fails inside a step; no shipped model does.

## Configuration contract (version 1)
```json
{
  "contractVersion": 1,
  "instanceId": "<process module instance id>",
  "factoryId": "<factory id>",
  "moduleType": "PUMP_HOUSE",
  "modelType": "PUMP_HOUSE",
  "modelVersion": 1,
  "configVersion": 3,
  "tickMs": 100,
  "clock": "wall",
  "parameters": { "ratedFlow": 50, "ratedPressure": 6 },
  "inputs": { "DUTY_RUN_CMD": 0 }
}
```
Refused with `422 invalid-configuration`: another `contractVersion`, a missing id, `tickMs`
outside 10–10000, an unknown clock, an unknown model type or another model version, a
parameter the model does not have or cannot use, an input the model does not read, a
`configVersion` below 1, and a body with fields the contract does not know. Z-Factory's
types for the contract are in `lib/domain/process-sim.ts`.

Errors: `401 unauthorized`, `404 not-found`, `409 wrong-state` (for example stepping an
instance that is not running), `422 invalid-configuration`, `400 bad-request`.

## Models
Each model names its inputs (what the PLC drives), its outputs (what the PLC reads) and
its parameters with generic defaults. The names are the signal keys of the shipped process
module types (TASK-601), so the registry of TASK-605 can bind them.

| Model (version) | Inputs | Outputs | Parameters |
|---|---|---|---|
| `PUMP_HOUSE` (1) | `DUTY_RUN_CMD`, `DUTY_SPEED_SETPOINT` (%; 100 when absent), `DISCHARGE_VALVE_CMD` (open when absent) | `DUTY_RUNNING`, `DUTY_SPEED` (%), `FLOW` (m3/h), `DISCHARGE_PRESSURE` (bar), `DISCHARGE_VALVE_OPEN`, `LOW_PRESSURE` | `ratedFlow` 50, `ratedPressure` 6, `rampTimeS` 5, `valveTravelS` 5, `lowPressureRatio` 0.3, `initialValveOpen` 1 |
| `TANK` (1) | `INLET_VALVE_CMD`, `OUTLET_VALVE_CMD`, `AGITATOR_RUN_CMD` | `LEVEL` (%), `CONTENT` (m3), `INLET_VALVE_OPEN`, `OUTLET_VALVE_OPEN`, `AGITATOR_RUNNING`, `HIGH_LEVEL`, `LEVEL_HIGH`, `LEVEL_LOW` | `volume` 10, `inflowRate` 20, `outflowRate` 15 (m3/h), `valveTravelS` 5, `initialLevel` 0, `highSwitchLevel` 90, `highAlarmLevel` 95, `lowAlarmLevel` 5 |

Pump house: the speed ramps linearly to the setpoint (or to zero) over `rampTimeS` for the
full range; flow is `ratedFlow × speed × valve opening`; pressure follows the affinity law
(`ratedPressure × speed²`); the low-pressure alarm needs a setpoint of at least half speed
reached and a pressure below `lowPressureRatio × ratedPressure`. Events: `PUMP_STARTED`,
`PUMP_STOPPED`, `ALARM_RAISED`, `ALARM_CLEARED`.

Tank: valves travel linearly over `valveTravelS`; the content changes by the open share of
the inflow and outflow rates; an empty tank gives nothing; alarms at the configured levels.

The service's model versions are the model's equations; a changed model is a new version
and Z-Factory names the version it configured (`modelVersion`), so a mismatch is refused.
The shipped process module types still carry `simulatorModelType: null`; naming the model
on a type is a new type version and belongs with the bridge (TASK-603).

## Observability
Structured JSON logs (`log/slog`) for every request, instance lifecycle change and event.
`GET /healthz` (no token): status, version, contract version, uptime, instance count,
model types. `GET /metrics` (token): instances by status, ticks total, duration of the last
tick, model types.

## Running it
- Development: `services/process-sim/README.md`. Go 1.26; the module has no dependencies
  beyond the standard library.
- Container: `docker compose --profile sim up -d process-sim` with `PROCESS_SIM_TOKEN` set:
  a distroless static binary as a non-root user, read-only filesystem, all capabilities
  dropped, `no-new-privileges`, 1 CPU, 256 MB, 128 processes, port `127.0.0.1:7700`.
- Z-Factory: `PROCESS_SIM_URL` and `PROCESS_SIM_TOKEN` (both optional; without them there
  is no process simulation). The client is `createProcessSimClient` in
  `lib/runtimes/process-sim/client.ts`.
- Tests: `go test -race ./...` in the service; `test/integration/process-sim.test.ts`
  starts the built binary when `PROCESS_SIM_BIN` names it, drives it through the client and
  restarts it. CI builds the binary and runs both.
