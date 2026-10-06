# Process Simulation Service

The process simulation service (`services/process-sim`, Go) is the ADR-0008 runtime for
process modules: a deterministic tick loop that hosts many module instances in one
process, behind a small JSON API that only the Z-Factory server talks to. It computes the
process response to what the PLC commands; the PLC stays the control authority. Built in
TASK-602; the bridge to PLC tags is below (TASK-603); the module designer is TASK-604, the
I/O registry TASK-605.

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
The shipped module types `PUMP_HOUSE` and `TANK` name the model of the same name in
`simulatorModelType` (`lib/process-modules/types.ts`; `PROCESS_SIM_MODELS` in
`lib/domain/process-sim.ts` gives the version). The column was reserved for this and is the
one thing a stored type version takes after the fact (migration `process_model_link`):
roles, signals and settings stay as they are, so nothing bound to them moves.

## Bridge (TASK-603)
The process bridge (`lib/runtimes/process-bridge/runtime.ts`, service
`lib/services/process-bridge-service.ts`) is the closed loop between the models in the
service and the PLCs of a factory:

```text
PLC program -> tag the program drives (%Q/%M) -> Modbus read  -> module OUTPUT signal -> model input
model output -> module INPUT/ALARM signal     -> Modbus write -> memory tag (%M)      -> PLC program
```

**Mappings.** One module signal is carried by one PLC tag. The bridge receives mappings as
`{ moduleId, signalKey, tagId }`; storing and allocating them is the module I/O registry
(TASK-605). Whoever supplies them, `lib/domain/process-bridge.ts` decides whether they are
accepted, with the same rules the device simulator applies to device signals:

| Rule | Refuses |
| --- | --- |
| `module-signal-direction` | an INTERNAL signal: the model computes it, no tag carries it |
| `modbus-mapping` | a tag without a Modbus mapping, or one of another factory |
| `tag-in-use` | a tag that already carries a device signal |
| `signal-plc-driven` | a tag a gateway may write (COMMAND/SETPOINT, READ_WRITE): the process is wired to what the program computes (ADR-0006) |
| `signal-address` | a command into the process that is not on `%Q` or `%M`; feedback that is not on `%M` (the runtime's Modbus server does not accept writes to `%I` or `%Q`, ADR-0009) |
| `signal-data-type` | on/off on a register tag or a number on a BOOL tag; numeric widths may differ, the codec scales |
| `signal-range` | a signal range the tag's `raw × scale + offset` range cannot carry |
| `signal-unit` | a tag whose unit differs from the signal's (a tag without a unit takes the signal's) |
| `duplicate-signal`, `duplicate-tag` | a signal mapped twice; a tag carrying two signals |
| `address-overlap` | two mapped tags of one PLC whose registers or bits share an address |
| `required-signal` | a required signal of the module's profile without a mapping |
| `module-role-*`, `module-interlock` | an incomplete module (docs/process-modules.md): it does not run |

A module with any issue is *blocked* and the bridge does not start; the error names the
module, the rule and the signal (`rule: process-mapping`). A module whose type names no
model is *skipped* with a reason. Optional signals may stay unmapped: the model uses its
defaults (a pump house without a speed setpoint runs at full speed).

**Timing.** The models are loaded with the `manual` clock. Every `PROCESS_BRIDGE_CYCLE_MS`
(default 200) the bridge reads the PLC-driven tags of every module, sends changed inputs,
steps each model by `cycleMs / PROCESS_SIM_TICK_MS` ticks (default 100 ms per tick, so two
ticks) and writes the outputs that changed, plus a periodic refresh of everything. One
cycle is therefore exactly one cycle of simulated time, however long the exchange took: a
slow PLC or a slow service makes the process wait, never jump ahead. A cycle still in
flight makes the next timer tick a no-op.

**Codecs and scaling.** The PLC bridge of the device simulator carries the values
(`lib/runtimes/device-sim/bridge.ts`): BOOL on coils, INT16/UINT16/INT32/UINT32/FLOAT32 on
holding registers with the tag's byte order, word order, scale and offset; a value beyond
the tag's range saturates. The model sees engineering values: a `%QW` setpoint with scale
0.01 arrives as 75.5 %, and a pressure in bar is written as a REAL into `%MD`, so the
program declares it `REAL`.

**Quality.** Every module carries a quality: `GOOD`; `STALE` while the service could not
advance the model (its values are from an earlier cycle; the PLC keeps the last feedback,
nothing is invented); `DISCONNECTED` while a PLC the module exchanges with does not answer
(it gets no feedback and its commands count as de-energized, as with the device
simulator). A service that restarted and forgot an instance gets it loaded again on the
next cycle. Changes are recorded as `PROCESS_QUALITY_CHANGED`.

**Events.** `PROCESS_BRIDGE_STARTED`/`STOPPED` (factory level); `CONNECTION_UP`/`DOWN`
with `link: process-bridge` per PLC; `PROCESS_STATE_CHANGED` for the model's own events
(`PUMP_STARTED`, …) with the module, event, message and tick; `PROCESS_ALARM_RAISED`/
`CLEARED` derived from the module's ALARM signals, which raise and clear an alarm coded
`PROCESS:<module>/<signal>` (docs/events-telemetry.md). Stopping the bridge clears its
alarms. Live module state (status, quality, inputs, outputs, active alarms, PLC links) is
read from bridge memory; events are the history.

**Lifecycle.** `startProcessBridge(deps, actor, factoryId, mappings)` plans, validates,
loads and starts; it needs `PROCESS_SIM_URL`/`PROCESS_SIM_TOKEN` and a configured Modbus
endpoint on every mapped PLC (a PLC that is not running drives nothing until it comes up).
`stopProcessBridge` unloads the models; `stopFactory` stops the bridge first. `startFactory`
does not start it until the registry (TASK-605) supplies the mappings. The module's stored
`status` follows the bridge (RUNNING/STOPPED).

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
  is no process simulation), `PROCESS_SIM_TICK_MS` and `PROCESS_BRIDGE_CYCLE_MS` for the
  bridge. The client is `createProcessSimClient` in `lib/runtimes/process-sim/client.ts`.
- Tests: `go test -race ./...` in the service; `test/integration/process-sim.test.ts`
  starts the built binary when `PROCESS_SIM_BIN` names it, drives it through the client and
  restarts it; `test/integration/process-bridge-runtime.test.ts` runs the bridge between the
  binary and a real OpenPLC runtime (`TEST_DOCKER=1`). CI builds the binary and runs all.
