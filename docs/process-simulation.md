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

**Mappings.** One module signal is carried by one PLC tag. The bindings are stored by the
module I/O registry (TASK-605, docs/process-modules.md → The PLC I/O registry) and read by
`planProcessBridge`; a caller may pass mappings `{ moduleId, signalKey, tagId }` instead.
Whoever supplies them, `lib/domain/process-bridge.ts` decides whether they are accepted,
with the same rules the device simulator applies to device signals:

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
next cycle. Changes are recorded as `PROCESS_QUALITY_CHANGED`. The module's quality is also
the quality of the feedback tags it writes, as the Live Tags screen shows them; with the
bridge stopped they are `STALE` (TASK-803, docs/events-telemetry.md → Live tags).

**Events.** `PROCESS_BRIDGE_STARTED`/`STOPPED` (factory level); `CONNECTION_UP`/`DOWN`
with `link: process-bridge` per PLC; `PROCESS_STATE_CHANGED` for the model's own events
(`PUMP_STARTED`, …) with the module, event, message and tick; `PROCESS_ALARM_RAISED`/
`CLEARED` derived from the module's ALARM signals, which raise and clear an alarm coded
`PROCESS:<module>/<signal>` (docs/events-telemetry.md). Stopping the bridge clears its
alarms. Live module state (status, quality, inputs, outputs, active alarms, PLC links) is
read from bridge memory; events are the history.

**Lifecycle.** `startProcessBridge(deps, actor, factoryId)` plans from the stored bindings,
validates, loads and starts; it needs `PROCESS_SIM_URL`/`PROCESS_SIM_TOKEN` and a configured
Modbus endpoint on every mapped PLC (a PLC that is not running drives nothing until it comes
up). `stopProcessBridge` writes every feedback tag de-energized (false / 0) so that the PLC
does not run on the values of a process that is gone (TASK-803; the PLC's commands are
never written), then unloads the models. `startFactory` starts the bridge after the device
simulation when the factory has modules with a model and bindings (a factory without them
has nothing to start and nothing to report; a blocked module or a missing service is
reported in `processNote`); `stopFactory` stops the bridge first. The module's stored
`status` follows the bridge (RUNNING/STOPPED).

## Overrides (Phase 08, TASK-801)
A test changes what the PLC reads, never what it decides. Each model declares its
**measured outputs** — the values a transmitter or switch would give the PLC — with unit and
range (`sim.Overridable`, ranges from the parameters the instance was reset with):

| Model | Measured outputs |
|---|---|
| `PUMP_HOUSE` | `DISCHARGE_PRESSURE` (bar, 0–2 × rated), `FLOW` (m3/h, 0–2 × rated), `DISCHARGE_VALVE_OPEN` (switch) |
| `TANK` | `LEVEL` (%, 0–100), `HIGH_LEVEL` (switch) |

Commands the PLC gives (model inputs), actuator states (`DUTY_RUNNING`, …) and the model's
own alarms are never overridable.

Every measured output has a mode:

```text
AUTO            -> effective = calculated (the model)
MANUAL_OVERRIDE -> effective = the value a tester set, held until cleared
SCENARIO        -> effective = a profile over simulated time: RAMP {from, to, durationS} (then held)
                   or STEPS [{atS, value}] (the first at 0 s)
```

The model keeps calculating; `outputs` (what the bridge delivers to the PLC) carry the
effective values; the model's own alarms follow the calculated values. An override survives
ticks, stop and start; a reset, a reload or an unload ends it — it is runtime test state,
never configuration. Setting and clearing record `OVERRIDE_SET` / `OVERRIDE_CLEARED` events
with who asked (`source`); clearing an output that is not overridden is not an error.

API (token-protected):

| Request | Body / result |
|---|---|
| `GET /v1/instances/{id}/overrides` | `{ signals: [{ signal, unit, bool, min, max, mode, calculated, effective, value?, profile?, sinceTick, sinceTimeS, source? }] }` for every measured output |
| `PUT /v1/instances/{id}/overrides/{signal}` | `{ mode, value?, profile?, source? }` → the signal's state; a command, an alarm or an actuator state → 422, a value out of range or of the wrong kind → 422, an unknown signal → 404 |
| `DELETE /v1/instances/{id}/overrides/{signal}?source=` | back to AUTO → the signal's state |

The snapshot lists the overridden signals under `overrides`. The contract's planned resource
`/simulations/{simulationId}/devices/{deviceId}/inputs/{inputId}/override` is realised as
`/v1/instances/{module instance}/overrides/{signal}`: an instance stands for one process
module, and its measured outputs are the inputs the PLC reads.

In Z-Factory, `setProcessOverride(deps, actor, moduleId, signal, { mode, value | profile })`,
`clearProcessOverride` and `listProcessOverrides` (process-bridge-service) accept only an
INPUT signal of a module running in the bridge, send the actor as the source, and record
`PROCESS_OVERRIDE_SET` / `PROCESS_OVERRIDE_CLEARED`. The bridge delivers the effective value
at its next cycle; nothing writes a PLC output.

## Scenarios (Phase 08, TASK-804)
A scenario is a repeatable closed-loop test: it asks for what an operator may ask for, changes what the simulation feeds the PLC, and checks what the PLC program does about it. It never writes what the program decides; an alarm, a trip or an output is expected, never set (ADR-0015).

**Definition.** JSON, validated by `scenarioSchema` (`lib/validation/scenario.ts`; types in `lib/domain/scenario.ts`). It has a `name`, an optional `description`, and 1–100 `steps`. Things are named the way an engineer names them, so one scenario runs on any factory built the same way.

| Step | What it does |
|---|---|
| `WRITE {plc, tag, value}` | writes a command or setpoint tag (`EXTERNAL_COMMAND`); any other tag refuses the run before it starts |
| `FORCE {device, value}` | forces a simulated sensor (number) or switch (true/false) of the device simulator |
| `OVERRIDE {module, signal, value}` | MANUAL_OVERRIDE of a process module's measured value |
| `RAMP {module, signal, from, to, durationS}` | SCENARIO profile (RAMP) of a process module's measured value |
| `CLEAR` | every forced and overridden value of the factory back to AUTO |
| `EXPECT {plc, tag, op, value, tolerance?, withinS = 10, holdS?}` | reads the tag until `op` (EQ, NE, GT, GTE, LT, LTE) holds, at most `withinS`; with `holdS` it must then hold that long |
| `WAIT {seconds}` | waits |

A step takes at most 300 s. A scenario takes at most 900 s, counting every WAIT and EXPECT at its limit.

**Run.** `runScenario(deps, actor, factoryId, scenario)` in `lib/services/scenario-service.ts`, with the screen at `/factories/[factoryId]/scenarios`.
- Before anything is changed, the run is refused when:
  - the definition is invalid;
  - a name does not exist in the factory;
  - a WRITE targets anything but a command or setpoint;
  - another scenario of the factory is running;
  - any value of the factory is out of AUTO (`scenario-overrides-active`). A run starts from AUTO so that it can be repeated.
- The refusal is recorded as `SCENARIO_REJECTED`.
- Otherwise the steps run in order. The first failing step ends the run (`FAILED`, later steps `SKIPPED`). Every value is returned to AUTO whatever the outcome.
- The report has, per step: the result, the last value read and the time.
- It also lists every value the run took out of AUTO, which is the evidence of what was overridden.
- Events: `SCENARIO_STARTED`, then `SCENARIO_COMPLETED` or `SCENARIO_FAILED` (docs/events-telemetry.md). Override changes made by a run carry its `runId`.

**Repeatability.** Process models advance in lockstep with the bridge. Device models follow real elapsed time. The PLC scans every 50 ms. So a scenario that expects settled values with a tolerance, and waits with `withinS` rather than fixed delays, gives the same steps, results and on/off readings on every run; only timings differ. The tests run each scenario twice and compare.

**Clear all.** `clearAllOverrides(deps, actor, factoryId)` releases every forced sensor or switch and every overridden process value of the factory, and records each release. `listActiveOverrides` lists what is out of AUTO. The Scenarios screen shows both, with a *Clear all overrides* button. The module editor's per-value controls are unchanged (TASK-802).

## Catalog device runtime (TASK-1009, ADR-0025)
Since TASK-1009 the same service hosts the **catalog device runtime**: the device
simulation of many factories, each a set of coupled behaviour profiles ticked
deterministically, beside the process-module instances above. It is additive: the
instance contract and its routes do not change. The runtime is the Phase 10 home of
device behaviour; the server's own device simulator (`lib/runtimes/device-sim`,
ADR-0010) keeps running factories until TASK-1015 switches them over, and
`lib/runtimes/process-sim/devices.ts` turns its configuration into the runtime's so both
read one source.

### Behaviour profiles
A profile is the documented generic behaviour of one device category. The runtime ships
the ten of the server's simulator, ported value for value (`internal/device`), and since
TASK-1011 the behaviour library (`RELAY`, `HEATER`, `INDICATOR`, `SOFT_STARTER`,
`MOTOR_STARTER`, `SERVO_DRIVE`, `SERVO_MOTOR`, `ENCODER`, `PID_CONTROLLER`,
`SIGNAL_CONDITIONER`, `ACTUATOR`; `docs/device-simulation.md` → The behaviour library),
which the server's simulator does not run: `VFD`,
`MOTOR`, `PUMP`, `FAN`, `CONVEYOR`, `MIXER`, `COMPRESSOR`, `VALVE`, `SENSOR`, `SWITCH`,
every one at version 1, with the signals, parameters, faults, states and approximations
of `docs/device-simulation.md`. `GET /v1/profiles` (and `/v1/profiles/{key}`) describes
each: key and version; signals with direction (`IN` the PLC drives, `OUT` the device
produces), kind (`BOOL` travels as 0 or 1, `NUMBER`), label and unit; faults with
severity, latching and whether the device reports them itself; links by role (`drive`
of a motor: a VFD; `motor` of a load: a motor; `measures` of a sensor or switch: the
device whose output a MEASURED source follows); the parameters with their generic
defaults and, since TASK-1010, `parameterSchema`: every parameter with its kind
(`NUMBER`, `CHOICE`, `STRUCTURED`), role (`RATING`, `TIMING`, `LIMIT`, `INITIAL`,
`SOURCE`, `SHAPE`, `EVENT`), unit, default, bounds (with inclusive or exclusive ends),
choices or kinds, exactly what `Configure` enforces; the states; whether a tester may
force the value (sensors: a number; switches: 0 or 1). The same facts are the behaviour
contract on the server (`lib/domain/behavior-contract.ts`, ADR-0026), and the parity test
compares the two. Z-Factory names a device's profile from the catalog's simulation
metadata (every catalog model's `simulation` block, `DEVICE_PROFILES` in
`lib/domain/process-sim.ts` by the category's `simulatorType`), never from a condition
in the UI; TASK-1011 adds the remaining categories.

### Factory contract (device contract version 1)
```json
{
  "contractVersion": 1,
  "factoryId": "<factory id>",
  "configVersion": 3,
  "tickMs": 100,
  "clock": "wall",
  "devices": [
    { "deviceId": "<device id>", "name": "VFD-01", "profile": "VFD", "profileVersion": 1,
      "parameters": { "accelTimeS": 4 }, "inputs": { "run": 0 } },
    { "deviceId": "<device id>", "name": "M-01", "profile": "MOTOR", "profileVersion": 1,
      "links": { "drive": "<vfd id>" }, "faults": { "OVERLOAD": { "latching": true } } }
  ]
}
```
`PUT /v1/factories/{factoryId}` loads or replaces a factory (`LOADED`, tick 0; every
device validated and every link checked before anything is kept). Refused with
`422 invalid-configuration` and the rule it breaks in `rule`: `contract-version`,
`factory-identity`, `tick` (10–10000 ms), `clock`, `config-version`, `device-limit`
(256 per factory, `PROCESS_SIM_MAX_DEVICES` over all), `unique-device`,
`device-identity`, `profile`, `profile-version`, `simulation-params` (an unknown or
invalid parameter, named), `supported-fault`, `link-role`, `link-target`, `drive`,
`one-motor-per-drive`, `motor`, `one-load-per-motor`, `measured-device`,
`measured-signal`, `contactor` and `controller` (TASK-1011: a heater's contactor is a relay,
a heater's or valve's controller a PID controller, a servo motor's drive a servo drive),
`input-signal`, and for protocol devices (TASK-1013) `protocol-kind`, `unit-id` (1–247),
`register-map` (a declared map), `register-map-version`, `register-map-profile` (the map
is the device's profile's), `unique-unit-id` (per factory), `modbus-listener` (a factory
with protocol devices names a `modbusTcp` port), `modbus-port` (0 or within the runtime's
range) and `modbus-listen` (the port could not be opened). Then, per factory: `start`, `stop`, `reset` (every
device rebuilt from its configuration, a `RESET` event), `step?ticks=n` (a RUNNING
factory; `409 wrong-state`, rule `factory-state`), `GET` (the snapshot with every
device), `DELETE`, `events?after=seq` (the last 500). Per device, while the factory is
loaded, running or stopped: `PUT …/devices/{deviceId}` adds or replaces one device
(fresh state; the others keep theirs; a configuration that breaks an invariant leaves
everything as it was), `DELETE` removes one (`409`, rule `linked-device`, while another
device links to it), `GET` its snapshot, `PUT …/inputs` replaces its PLC-driven inputs
(an absent input counts as not wired; a key that is not an input of the profile is
refused), `POST`/`DELETE …/faults/{code}` injects or clears a fault (`fault-active`,
`fault-not-active`, `supported-fault`), `POST …/reset` is the operator's reset (refused
while a latching fault is present), `PUT …/force` `{ "value": n }` and `DELETE …/force`
force and release a sensor or switch (`forcible-device`).

A device snapshot carries its profile and version, its runtime `status` (`OK`,
`FAULTED`, `QUARANTINED`), the behaviour's `state` (`STOPPED`, `ACCELERATING`, `OPEN`,
`DRY_RUN`, `GOOD` …), `faulted`, `tripped`, `activeFaults`, `quality` (`BAD` for a
sensor that lost its signal and for a device the runtime set aside), `inputs`,
`outputs`, `forced`, the behaviour's `internal` numbers and an `error`. The factory's
summary counts devices by status and says whether a wall-clock factory `stalled` (no
tick for five ticks while RUNNING).

Events are the server simulator's, numbered per factory and stamped with the tick:
`VFD_STATE_CHANGED`, `MOTOR_STATE_CHANGED`, `PUMP_STATE_CHANGED`, `VALVE_STATE_CHANGED`,
`SENSOR_VALUE_CHANGED` (at the configured deadband), `DEVICE_STATE_CHANGED`,
`FAULT_INJECTED`, `FAULT_CLEARED`, `DEVICE_RESET`, `SIMULATED_INPUT_FORCED`,
`SIMULATED_INPUT_RELEASED`, plus the runtime's `DEVICE_RUNTIME_FAULT`,
`DEVICE_QUARANTINED` and `RESET`, and since TASK-1011 `FAULT_RAISED` (a fault a behaviour
raised from its own physics; `FAULT_CLEARED` with `by: model` when it releases it), and
since TASK-1013 `PROTOCOL_WRITE` (a signal a client set over the network, with the unit
id, area and value) and `PROTOCOL_WRITE_REJECTED` (a refused write, at most once per
address every 30 seconds).

### Register maps and the Modbus listener (TASK-1013, ADR-0027)
A protocol-controlled device is a behaviour profile behind a **declared register map**:
every register is one signal of the profile at one Modbus area and address, with its
data type, scale, offset, unit, access and role, and for a writable register the range a
write must stay in. The area and the access follow from the signal: a boolean command is
a coil, a numeric setpoint a holding register, boolean feedback a discrete input, numeric
feedback an input register; commands and setpoints are `READ_WRITE`, feedback
`READ_ONLY`. `GET /v1/register-maps` (and `/v1/register-maps/{key}`) describes every map
the runtime serves (`internal/device/registers.go`, validated against the profile when
declared); the same maps are the contract on the server (`lib/domain/register-maps.ts`),
and the parity test compares the two field by field. Z-Factory ships one map,
`VFD_MODBUS_TCP` v1, the generic Modbus drive's (`docs/device-simulation.md` →
Protocol-controlled devices). A vendor's map would be catalog data with its provenance
(TASK-1012) and is never guessed: a device may name only a declared map.

A device is served by naming its protocol in its configuration
(`"protocol": { "kind": "MODBUS_TCP", "unitId": 7, "registerMap": "VFD_MODBUS_TCP",
"registerMapVersion": 1 }`) in a factory that asks for a listener
(`"modbusTcp": { "port": 0 }`; 0 takes any free port, otherwise a port of
`PROCESS_SIM_MODBUS_PORTS`). The runtime opens one Modbus TCP listener per such factory
on `PROCESS_SIM_MODBUS_BIND` (default `127.0.0.1`) when the factory is loaded and closes
it when the factory is unloaded or replaced; the summary reports it under `modbusTcp`
(address, port, devices served) and a device snapshot carries its `protocol`. Every
protocol device of the factory answers at its unit id:

| Request | Answer |
|---|---|
| read coils / holding registers of mapped addresses | the device's commands and setpoints as last written, scaled to raw words |
| read discrete inputs / input registers of mapped addresses | the device's feedback as the behaviour produced it at the last step, scaled |
| write a coil or holding register the map names as writable | the behaviour's input is set (engineering value = raw × scale + offset), checked against the register's range (a bound naming a parameter is resolved against the device's effective parameters); `PROTOCOL_WRITE` per changed signal |
| write several registers at once | applied whole or not at all |
| an address the map does not name, or a write to a read-only area | exception `02`, nothing touched; `PROTOCOL_WRITE_REJECTED` |
| a value outside the register's range | exception `03`, nothing touched; `PROTOCOL_WRITE_REJECTED` |
| a unit id no device has | exception `0A` |
| a function other than 1–6, 15, 16, or a malformed request | exception `01` / `03`; a connection that does not speak Modbus TCP is closed |

The behaviour is the same as a hardwired device's: a write over Modbus lands on the same
input a PLC output wired to a terminal would set, and the next step reacts to it. The
runtime never writes a PLC output; it only takes what a client writes to the device
(ADR-0015). A listener takes at most 8 connections and closes one that is silent for two
minutes; it has no authentication, like every Modbus TCP server (`docs/security.md`).

What is not done: reaching a listener from a PLC container. The runtime listens on the
host's loopback by default and PLC containers live on factory networks; TASK-1015 decides
the network path and configures the PLC's Modbus master for the device. A remote I/O
station has no profile yet, because it exposes channels rather than a behaviour.

### Determinism and isolation
Within a factory the step order is fixed: drives, motors, loads, valves, then sensors
and switches, which observe what the actors produced in the same step; links are
pointers, so a motor reads its drive's signed frequency and its load's torque, a load
its motor's speed. A RANDOM source uses the same seeded generator as the server
(mulberry32), so the two simulators agree sample for sample;
`test/integration/process-sim.test.ts` steps the same seven-device chain in both and
compares every output. Each factory ticks on its own goroutine: one cannot stall
another. Within a factory a behaviour that panics is `FAULTED` and one that overruns
its step budget (50 ms) three times in a row is `QUARANTINED`; both are skipped with
frozen outputs and BAD quality while the others go on, each with a critical event, and
configuring the device again brings it back. Quarantine depends on the host's speed and
is reported, never silent; the outputs of healthy devices stay deterministic.

The PLC stays the control authority (ADR-0015): the runtime takes the inputs the PLC
drives and gives feedback; it never sets a PLC output, and forcing is confined to
sensors and switches.

## Observability
Structured JSON logs (`log/slog`) for every request, instance lifecycle change and event.
`GET /healthz` (no token): status, version, contract version, device contract version,
uptime, instance count, model types, factory and device counts, profiles, register maps. `GET /metrics`
(token): instances by status, ticks total, duration of the last tick, model types, and
under `devices` the runtime's counters: factories and devices by status, the device
limit, factory ticks total, the last tick's duration, stalled factories, profiles.

## Running it
- Development: `services/process-sim/README.md`. Go 1.26; the module has no dependencies
  beyond the standard library.
- Container: `docker compose --profile sim up -d process-sim` with `PROCESS_SIM_TOKEN` set:
  a distroless static binary as a non-root user, read-only filesystem, all capabilities
  dropped, `no-new-privileges`, 1 CPU, 256 MB, 128 processes, port `127.0.0.1:7700`.
- Z-Factory: `PROCESS_SIM_URL` and `PROCESS_SIM_TOKEN` (both optional; without them there
  is no process simulation), `PROCESS_SIM_TICK_MS` and `PROCESS_BRIDGE_CYCLE_MS` for the
  bridge. The client is `createProcessSimClient` in `lib/runtimes/process-sim/client.ts`.
- The service's Modbus listeners (TASK-1013): `PROCESS_SIM_MODBUS_BIND` (default
  `127.0.0.1`) and `PROCESS_SIM_MODBUS_PORTS` (default `17000-17999`); the compose file
  passes both through and publishes no listener port, so a served device is reachable
  only inside the container until TASK-1015 decides the network path.
- Tests: `go test -race ./...` in the service; `test/integration/process-sim.test.ts`
  starts the built binary when `PROCESS_SIM_BIN` names it, drives it through the client and
  restarts it, and (TASK-1009) loads a factory of devices into the catalog device runtime,
  compares its outputs with the server's simulator, and exercises the device routes;
  `test/integration/process-bridge-runtime.test.ts` runs the bridge between the binary
  and a real OpenPLC runtime (`TEST_DOCKER=1`). CI builds the binary and runs all.
