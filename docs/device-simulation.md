# Device Simulation

## Purpose
Model industrial peripheral behavior around the PLC so Z-Factory can execute an end-to-end control loop rather than only expose PLC tags.

## Runtime strategy
Use a shared device-simulator engine/process for ordinary peripherals. It hosts many factory-specific device state machines. Do not create one container per simple device by default.

Phases 02–05 keep this simulator inside the MVP architecture. Phase 06 may introduce the ADR-0008 Go service for coupled process modules; that service supplements rather than replaces the generic device runtime.

## Device behaviors

### Sensor
Generates a process value/state based on a simulation profile or coupled process model.

Examples: temperature, pressure, level, flow, proximity, vibration, current, voltage, position.

### Switch
Produces discrete ON/OFF or multi-position state.

### Valve
Consumes open/close/position command and calculates actual state/position, travel delay, end-switch feedback and optional fault.

### VFD
Consumes run/stop, direction, frequency/speed setpoint and reset commands. Calculates/ramp-up/ramp-down actual frequency plus current/torque/status/fault feedback.

MVP invariant: one VFD instance drives one primary motor instance.

### Motor
Consumes drive/contactor command. Calculates actual RPM and selected derived values such as current, torque and temperature using an explicitly documented approximation.

### Pump/Fan/Conveyor/Mixer/Compressor
Consumes motor state and produces domain state. A pump may produce flow/pressure; a conveyor produces speed/motion; a fan produces airflow proxy.

## Closed-loop example

```text
Pressure sensor
   -> PLC process value
   -> PID/control logic
   -> VFD frequency setpoint
   -> VFD actual frequency
   -> motor RPM
   -> pump flow/pressure
   -> pressure sensor value
```

## State-update model
Simulation runs at a configured tick interval. A tick updates in-memory state, emits meaningful events, and optionally updates selected runtime snapshots/telemetry.

For advanced process modules, the same principle applies: the process model receives elapsed simulation time `dt`, current state and PLC-driven inputs, then deterministically computes the next state. Duration emerges from the model; do not fake physical response with a fixed timer unless the process recipe explicitly includes a timed stage.

Do not persist every tick by default.

## Process-module boundary
Device models answer questions such as "how does this VFD/motor/valve react?" A process model answers "how do several devices affect the process together?"

Canonical process loop:

```text
process model -> virtual/assigned sensor feedback -> PLC input/tag
PLC logic -> command/setpoint -> device/process model -> next process state
```

The PLC owns control decisions. The simulator must not turn a heater, valve, pump or drive on merely because a target value was configured.

Boiler-specific thermal zones, equations and I/O are deferred to Phase 07 and documented as a module, not as generic sensor behavior.

## Commands and feedback
Command/setpoint values are distinct from actual feedback.

Example:
- `VFD01_FrequencySetpoint = 45.0 Hz`
- `VFD01_ActualFrequency = 44.8 Hz`
- `Motor01_RPM_Setpoint = 1450`
- `Motor01_ActualRPM = 1438`

## Faults
Device models may define supported fault types. Injection/reset must be explicit, auditable and visible in UI. Examples: VFD overcurrent, motor overload, sensor bad quality, valve stuck, pump dry-run approximation.

## Fidelity rule
Simulation behavior is an approximation for software/control testing. Never present it as electrical/mechanical/process certification or exact manufacturer physics.

## Implementation (TASK-204)
Code: `lib/domain/simulation.ts` (vocabulary), `lib/runtimes/device-sim/` (models, engine, PLC bridge, runtime), `lib/services/simulation-service.ts`. Decisions: ADR-0010.

### Runtime
One simulator object in the server process hosts all factories. Each factory simulation has its own devices, PLC bridge and timer. A cycle (default 100 ms, `SIMULATION_TICK_MS`):

1. read the tags PLC logic drives (grouped into few Modbus requests);
2. advance every device by the real elapsed time (capped at 1 s per cycle);
3. write feedback tags that changed, plus a full refresh every 50 cycles;
4. emit events for meaningful changes; store snapshots at the snapshot interval.

A cycle that is still talking to a PLC makes the next timer tick a no-op. A PLC that cannot be reached is retried every 2 s; meanwhile the device inputs it drives are de-energized (false / 0), as with a stopped PLC. Simulations are not resumed after a server restart.

### What is simulated
A device instance is simulated when its model's runtime is `DEVICE_SIM` and its category's simulator type is one of the following. `RELAY`, `GENERIC` and `NONE` are skipped.

| Type | Driven by | Signals from the PLC (IN) | Signals to the PLC (OUT) |
|---|---|---|---|
| VFD | — | `run`, `reverse`, `frequencySetpoint` (Hz), `faultReset` | `running`, `atSetpoint`, `faulted`, `actualFrequency` (Hz), `outputCurrent` (A) |
| MOTOR | its VFD (`DRIVES`), else `run` | `run`, `faultReset` | `running`, `faulted`, `actualSpeed` (rpm), `current` (A) |
| PUMP | its motor (`MECHANICALLY_DRIVES`) | — | `running`, `faulted`, `flow`, `pressure` |
| FAN, CONVEYOR, MIXER, COMPRESSOR | its motor | — | `running`, `faulted`, `output` |
| VALVE | — | `open`, `close`, `positionSetpoint` (%), `faultReset` | `position` (%), `opened`, `closed`, `faulted` |
| SENSOR | profile, or the device it `MEASURES` | — | `value`, `faulted` |
| SWITCH | profile, or the device it `MEASURES` | — | `state` |

### Wiring to a PLC
A tag with `sourceDeviceInstanceId` and `sourceSignal` wires one device signal. Rules, checked when the tag is created:

- The device must be simulated and have that signal; a BOOL signal needs a BOOL tag, a number a numeric tag.
- The tag must be read-only for gateways and the UI (any role except `COMMAND` / `SETPOINT`). PLC logic alone drives devices.
- An IN signal takes a `%Q` or `%M` address the program assigns.
- An OUT signal takes a `%M` address. The runtime does not accept external values on `%I` (ADR-0010), so programs read simulated feedback from memory variables.
- One tag per device signal.

The tag's scale and offset convert between the simulated engineering value and the PLC's raw value. A value outside the tag's range saturates.

### Parameters
From the device's `SimulationProfile` (`docs/database.md`): the instance's own, else the model's (the catalog's `simulation.parameters`, TASK-1010); every value has a generic default. Defaults are not vendor data. The machine-readable description of every parameter, with unit, bounds and role, is the behaviour contract below.

| Type | Parameters (default) |
|---|---|
| VFD | `maxFrequencyHz` (50), `accelTimeS` (5), `decelTimeS` (5) |
| MOTOR | `ratedSpeedRpm` (1450), `ratedFrequencyHz` (50), `ratedCurrentA` (10), `noLoadCurrentRatio` (0.35), `timeConstantS` (0.5), `coastTimeConstantS` (2) |
| PUMP | `ratedFlow` (100), `ratedPressure` (4) |
| other loads | `ratedOutput` (100), `loadProfile` (`QUADRATIC` for fans, else `CONSTANT`) |
| VALVE | `travelTimeS` (5), `initialPosition` (0) |
| SENSOR | `source`, `rangeMin`, `rangeMax`, `timeConstantS` (0), `initialValue`, `eventDeadband` |
| SWITCH | `source` |

Sensor sources: `CONSTANT {value}`, `RAMP {from, to, periodS}`, `SINE {min, max, periodS}`, `RANDOM {min, max, intervalS, seed}`, `MEASURED {signal, gain, offset}`. Switch sources: `CONSTANT {state}`, `MEASURED {signal, onAbove, offBelow}`. A `MEASURED` source needs a `MEASURES` connection from the sensor or switch to the measured device.

### Approximations
- **VFD:** linear ramp at `maxFrequencyHz / accelTimeS` (or `decelTimeS`). The setpoint is limited to 0…`maxFrequencyHz`. A change of direction ramps through zero. No V/f curve, current limit, DC bus or braking model.
- **Motor:** speed = rated speed × supply frequency / rated frequency, reached with a first-order lag. Slip, inrush current and thermal behaviour are not modelled. Current = rated × (no-load share + remaining share × load torque).
- **Pump:** affinity laws against a fixed system: flow ∝ speed, pressure ∝ speed². No pump curve, no interaction with valves or tanks (that is process simulation, Phase 06).
- **Other loads:** output ∝ speed; torque is quadratic (fan) or constant.
- **Valve:** constant travel speed. With only `open` wired it returns to closed when the command drops; with `close` also wired it holds position when neither is present; `positionSetpoint` takes precedence.
- **Sensor:** ideal source, optional first-order lag, limited to its range. No noise or drift unless a `RANDOM` source is configured.

### Faults
| Type | Code | Effect | Latching |
|---|---|---|---|
| VFD | `OVERCURRENT`, `OVERTEMPERATURE` | output removed at once; the motor coasts | yes |
| MOTOR | `OVERLOAD` | motor de-energized even while its drive runs | yes |
| PUMP | `DRY_RUN` | no flow or pressure; motor load drops | no |
| VALVE | `STUCK` | does not move; not reported on `faulted` | no |
| VALVE | `LIMIT_SWITCH_FAULT` | both limit switches read closed whatever the position; not reported (TASK-1014) | no |
| SENSOR | `BAD_QUALITY` | reads bottom of range, `faulted` true, quality BAD | no |
| SENSOR, SWITCH | `STUCK` | value frozen; not reported | no |
| every type | `OFFLINE` | the device unavailable: not stepped, every output de-energized, quality BAD; restarts from its initial state when the fault ends (TASK-1014) | no |

A latching fault trips the device: it stays faulted after the cause is cleared until it is reset, by a rising edge on its `faultReset` signal from the PLC or by an operator reset. A catalog `DeviceFaultDefinition` with the same code overrides severity and latching (`MANUAL` = latching). The standard every fault follows, in both simulators, is under "Faults, failures and degraded quality" below.

### Limits
- The simulator screen of a stored factory (TASK-305) starts and stops the simulation, shows each device's command and feedback signals with the tags they are wired to, and injects, clears and resets faults. Forcing a sensor or switch value has a service but no control on the screen yet.
- A simulation lives in the server process. After a server restart it is gone and has to be started again. Stored device states left over from it are corrected to stopped the next time a live screen or stream of the factory is opened (TASK-401).
- A motor drives one load; a second `MECHANICALLY_DRIVES` connection from the same motor refuses the start.
- The measured signal of a sensor is named in its profile, not on the `MEASURES` connection.
- A device fault raises an alarm (`AlarmEvent`, code `FAULT:<code>`) that ends when the fault is gone, for a latching fault when the device leaves its faulted state, and in any case when the simulation stops (TASK-401).
- Relays, contactors, heaters, indicators, starters, servo drives and motors, encoders, controllers, signal conditioners and cylinders are not simulated by the server's simulator; the runtime models them (The behaviour library below) and TASK-1015 brings them to factories.


## PLC I/O authority in simulation
ADR-0015 applies to the simulator.

- Simulator-generated sensor/process values are injected into the virtual PLC through the simulation bridge.
- PLC logic consumes those values and writes its own local output variables.
- The device simulator reads the program-generated outputs as commands to the simulated actuators.
- The simulator never becomes the authority for PLC outputs.
- Modbus is an implementation transport between the simulator and OpenPLC memory/registers; it is not the industrial meaning of the local I/O connection.
- When targeting a real PLC, simulator injection is replaced by physical inputs or the selected real remote-I/O/device protocol, while the program still owns local outputs.

## Command bridge (TASK-803)
The control path of Phase 08 runs through the two bridges that already exist; TASK-803 makes each step explicit and keeps loss visible.

```text
PLC program -> program-driven tag (PROGRAM_OUTPUT: %Q, or %M the program writes)
            -> bridge read -> simulated device command (run, frequencySetpoint, open, …)
            -> device model over time (ramp, travel, inertia, faults)        [device simulator]
            -> process model over time (pressure, flow, level)                [Go service, process bridge]
            -> actual feedback (actualFrequency, position, opened, …)
            -> bridge write -> SIMULATION_FEEDBACK memory (%M) -> PLC program
```

- **Command and actual stay separate.** A command signal (`run`, `frequencySetpoint`, `open`, `positionSetpoint`, a module OUTPUT) and its actual value (`running`, `actualFrequency`, `position`, `opened`/`closed`, a module INPUT) are different signals on different tags. A tag carrying a command is `PROGRAM_OUTPUT` wherever it sits, `%M` included; a tag carrying feedback is `SIMULATION_FEEDBACK`. Neither is writable from outside (`tagAuthority`, `deviceSignalDirection` in `lib/domain/simulation.ts`: a signal key flows the same way in every device type).
- **Only the program commands.** The bridges read what the scan cycle wrote; no UI action or gateway write produces a device command (ADR-0015). Test conditions go through simulation overrides and forced sensor values, never through the PLC's outputs.
- **Dynamic response.** The models answer over simulated time: the drive ramps, the motor follows with its time constant, the valve travels its stroke and its limit switches change at the ends, a stuck valve does not move. Nothing jumps to the commanded value unless the model says so.
- **Loss is explicit.** A PLC the bridge cannot read drives nothing: its commands count as de-energized. A bridge that stops (the simulation is stopped, the process bridge is stopped) writes every feedback tag de-energized (false / 0, or the bottom of a range that excludes 0), as the wiring of powered-down equipment reads, so the program sees running and limit-switch signals drop instead of running on the last values; the PLC's commands are never written. On the Live Tags screen the feedback carries the quality of its writer (`STALE`, `DISCONNECTED`, `BAD`; docs/events-telemetry.md → Live tags), so a PLC that answers does not make held feedback look healthy.

Code: `PlcBridge.release` and `linkUp` (`lib/runtimes/device-sim/bridge.ts`), `feedbackQuality` of the device simulator and of the process bridge, `writerQuality` of the tag monitor (`lib/runtimes/tag-monitor/monitor.ts`), `feedbackQuality` in `lib/domain/live.ts`. Tests: `test/integration/command-bridge.test.ts` (Docker) runs a valve and a drive against a real OpenPLC program that opens the valve on request and runs the drive only once the open limit switch proves it open.

As built (TASK-205): the bridge reads `PROGRAM_OUTPUT` tags (`%Q`, and `%M` the program writes) and delivers feedback to `%M` memory only — the `PROGRAM_INPUT` shadow of a wired DI/AI channel or `SIMULATION_FEEDBACK` memory — never to a `%Q` address, an input point or a command tag (`signal-address`). The owner model and its enforcement are in `docs/openplc-runtime.md` → As built (TASK-205); the process bridge of `docs/process-simulation.md` follows the same rule.


## Phase 10 direction — catalog-driven Go device simulator

Phase 10 expands device behavior simulation into the Go simulation runtime so the complete catalog has an explicit executable-support decision.

This does **not** mean every vendor product is firmware-emulated. When no legal/usable vendor runtime, emulator or Docker image exists, Z-Factory runs a documented behavior profile. Model-specific values are used only when supported by authoritative catalog sources: as built in TASK-1012, a vendor model runs the generic profile of its category, its factory values and declared features come from the manufacturer's manual with a source per fact, and the approximation of the mapping is stated with the fact (`docs/device-catalog.md` → Vendor models on behaviour profiles).

Every catalog model must declare one coverage state (as built in TASK-1010: the `simulation` block of every catalog model, checked against the behaviour contract and stored on `DeviceModel`; `docs/device-catalog.md` → Simulation decision):
- `FULL`: every Z-Factory-declared behavior for the model is implemented.
- `PARTIAL`: a defined subset is implemented.
- `GENERIC`: category behavior is available but not vendor/model-specific behavior.
- `NOT_SIMULATABLE`: configuration/metadata only.

The target behavior contract includes, where meaningful:
- commands and setpoints;
- actual feedback and quality;
- parameters and engineering units;
- states and state transitions;
- timing, ramps, travel and inertia;
- ranges/limits;
- faults, latching and reset;
- protocol/register behavior from authoritative mappings;
- relationships to other devices.

Target categories include drives/starters, motors, pumps/fans/conveyors/mixers/compressors, valves/actuators, relays/contactors/SSR, heaters, indicators/buzzers, switches/buttons, proximity/photoelectric sensors, process transmitters, encoders, process/PID/temperature controllers, remote I/O, IO-Link masters, protocol converters/gateways and related catalog devices.

The simulator remains subordinate to PLC program authority: it consumes program-generated commands and returns simulated feedback. It never decides local PLC physical outputs on behalf of the program.

Execution tasks: TASK-1009 through TASK-1016 in `docs/phases/phase-10-agent-ready-catalog-simulator/tasks/`.

### The behaviour contract (TASK-1010, ADR-0026)
`lib/domain/behavior-contract.ts` is the one machine-readable statement of every behaviour profile, the contract the catalog (`docs/device-catalog.md` → Simulation decision), the parameter forms, the runtime's profile map and the coverage report (TASK-1016) read. Per profile (`BEHAVIOR_PROFILES`, one per simulated type, version 1):

| Part | What it states |
|---|---|
| `signals` | commands and setpoints (`IN`, PLC logic drives them) and feedback (`OUT`), each with kind, label, unit and, for a number, its range by fixed bounds (`position` 0–100 %) or by the parameter that sets a bound (`actualFrequency` up to `maxFrequencyHz`, `value` within `rangeMin`…`rangeMax`) |
| `parameters` | `NUMBER` (unit, generic default or none, bounds with inclusive or exclusive ends), `CHOICE` (the allowed values) or `STRUCTURED` (the kinds a signal source may take, each with its fields); each with a role: `RATING`, `TIMING` (ramps, lags, travel), `LIMIT`, `INITIAL`, `SOURCE`, `SHAPE`, `EVENT` |
| `states` | the behaviour's states (`STOPPED`, `ACCELERATING`, `OPEN`, `DRY_RUN`, `GOOD`, `BAD` …) |
| `faults` | code, name, severity, latching, silent, and from these the reset rule (`AUTO` when the cause ends, `RESET_SIGNAL_OR_OPERATOR` for a trip), the effect in words, and the quality of the feedback while present (`BAD_QUALITY` of a sensor is `BAD`) |
| `badQualityOnFaults` | the faults that make the feedback BAD; a device the runtime sets aside (ADR-0025) is always BAD |
| `links` | couplings by role (`drive`, `motor`, `measures`), whether required, the profiles accepted, the connection relationship they are made from (`DRIVES`, `MECHANICALLY_DRIVES`, `MEASURES`) and which side the peer is |
| `protocol` | `NONE` for every shipped profile; a profile the runtime serves over Modbus TCP will say so (TASK-1013) |
| `forcible`, `forcedKind` | whether a tester may force the value (sensors a number, switches 0 or 1; ADR-0015) |
| `fidelity` | the approximations in words and what is deliberately not modelled |

The Go runtime describes the same profiles (`GET /v1/profiles`, now with `parameterSchema` beside the defaults) and its `Configure` refuses exactly what the schema excludes (`internal/device/schema_test.go` walks every bound); `test/integration/process-sim.test.ts` compares the two descriptions field by field, so the contract and the code that runs it cannot drift apart. `checkParameterValue` is the one check the catalog applies to a model's parameter values. `coverageStatement` is the sentence shown with a coverage state: a behaviour model, not vendor firmware.

### The behaviour library (TASK-1011)
Runtime-only profiles (`runsOn.server` false in the contract): implemented and tested in `services/process-sim/internal/device`, described over `GET /v1/profiles` and in `lib/domain/behavior-contract.ts`, held together by the parity test. The server's simulator does not run them, so catalog models of these categories stay `NOT_SIMULATABLE` with that reason until TASK-1015 moves factories to the runtime; the catalog refuses a `DEVICE_SIM` model on such a profile. Every profile is a documented generic approximation; what is absent is stated, nothing vendor-specific is invented. Owner's decisions in `docs/phases/phase-10-agent-ready-catalog-simulator/tasks/TASK-1011.md`.

| Profile | Signals from the PLC (IN) | Signals to the PLC (OUT) | Links | Parameters (default) | Faults |
|---|---|---|---|---|---|
| `RELAY` (relay, contactor, solid-state relay) | `coil` | `closed`, `auxNo`, `auxNc` | feeds a motor (`drive` of the motor) or a heater (`contactor` of the heater) | `kind` (ELECTROMECHANICAL / SOLID_STATE), `pickupTimeS` (0.02), `dropoutTimeS` (0.02) | `WELDED_CONTACTS`, `COIL_OPEN` (both silent) |
| `HEATER` | `on`, `power` (%), `faultReset` | `heating`, `temperature` (°C), `powerOutput` (kW), `cutout`, `faulted` | `contactor` (a RELAY; without one, `on` energizes it) | `ratedPowerKw` (5), `ambientC` (20), `riseAtFullPowerC` (100), `timeConstantS` (300), `maxTemperatureC` (250), `cutoutHysteresisC` (10), `initialTemperatureC` | `OVERTEMPERATURE` (latching), `ELEMENT_FAILURE` (silent) |
| `INDICATOR` (stack light, lamp, buzzer) | `red`, `amber`, `green`, `blue`, `buzzer`, `flash` | `redLit`, `amberLit`, `greenLit`, `blueLit`, `buzzerOn` | — | `flashRateHz` (1) | `LAMP_FAILURE` (silent) |
| `SOFT_STARTER` | `run`, `faultReset` | `running`, `bypassed`, `faulted`, `outputVoltage` (%), `outputCurrent` (A) | feeds a motor (`drive` of the motor) | `initialVoltagePct` (30), `rampTimeS` (5), `rampDownTimeS` (0) | `OVERCURRENT`, `OVERTEMPERATURE` (latching) |
| `MOTOR_STARTER` (direct-on-line with overload relay) | `run`, `faultReset` | `running`, `faulted`, `current` (A), `thermalLoad` (%) | feeds a motor | `overloadSettingA` (10), `tripClass` (10), `coolingTimeS` (120) | `OVERLOAD` (latching; raised by the relay's own thermal image, or injected) |
| `SERVO_DRIVE` | `enable`, `positionSetpoint` (units), `faultReset` | `enabled`, `inPosition`, `moving`, `faulted`, `actualPosition`, `actualVelocity` | positions a servo motor (`drive` of the servo motor) | `maxVelocity` (1000), `acceleration` (5000), `deceleration` (5000), `inPositionWindow` (1), `initialPosition` (0) | `FOLLOWING_ERROR`, `OVERCURRENT` (latching) |
| `SERVO_MOTOR` | `faultReset` | `running`, `faulted`, `actualPosition`, `actualVelocity`, `current` (A) | `drive` (a SERVO_DRIVE; required) | `ratedCurrentA` (5), `holdingCurrentRatio` (0.1), `ratedVelocity` (1000) | `OVERTEMPERATURE` (latching) |
| `ENCODER` | — | `count` (pulses), `speed` (rpm) | `measures` (a MOTOR or SERVO_MOTOR; required) | `kind` (INCREMENTAL / ABSOLUTE), `pulsesPerRevolution` (1024), `unitsPerRevolution` (1) | `SIGNAL_LOSS` (silent, quality BAD) |
| `PID_CONTROLLER` (process and temperature controllers) | `enable`, `setpoint`, `manual`, `manualOutput` (%), `faultReset` | `output` (%), `processValue`, `error`, `atSetpoint`, `alarmHigh`, `alarmLow`, `faulted` | `measures` (the process-value device; required); a heater or valve takes its output through their `controller` link | `source` (MEASURED signal), `kp` (1), `ki` (0.1), `kd` (0), `outputMin` (0), `outputMax` (100), `setpoint` (0), `action` (REVERSE / DIRECT), `deadband` (1), `alarmHigh`, `alarmLow` | `INPUT_FAILURE` |
| `SIGNAL_CONDITIONER` (isolator, converter) | — | `value`, `faulted` | `measures` (required) | `source` (MEASURED signal), `inputMin` (0), `inputMax` (100), `outputMin` (0), `outputMax` (100) | `OPEN_INPUT` (quality BAD) |
| `ACTUATOR` (pneumatic cylinder) | `extend`, `retract` | `extended`, `retracted`, `moving`, `position` (%) | — | `kind` (DOUBLE_ACTING / SINGLE_ACTING), `extendTimeS` (1), `retractTimeS` (1), `initialPosition` (0) | `STUCK`, `AIR_LOSS` (silent) |

Approximations:
- **Relay:** one pickup and one dropout delay (none for a solid-state relay); the auxiliary contacts follow the main contacts exactly; welded contacts stay closed whatever the coil does, an open coil never closes them. No bounce, arcing, wear, inrush or contact resistance. A motor whose `drive` is a relay runs at line frequency while the contacts are closed (the motor's supply is abstracted: a drive gives a frequency, a relay or starter the line, a starter may limit the speed while it ramps).
- **Heater:** one lumped thermal mass with one time constant: the element temperature moves with a first-order lag towards ambient plus the rise at the delivered power share, and cools the same way; a thermostat cutout removes power above the maximum temperature until the element has cooled by the hysteresis. No element resistance, supply voltage, radiation or air flow, and not the process being heated (that is process simulation).
- **Indicator:** lamps are on or off, lit for the first half of every flash period while the flash command is on; one buzzer tone. No brightness, lamp test or sound level.
- **Soft starter:** a linear voltage ramp from the initial voltage to full, then the bypass; the motor's speed is held to the voltage share while it ramps. No torque curve, current limit, kick start or braking.
- **Motor starter:** a direct-on-line contactor and one thermal image of the overload relay that grows as the square of the overload above the setting and reaches its limit after the trip class time at 7.2 times the setting, cooling with its time constant below it; the model raises the `OVERLOAD` fault itself (`FAULT_RAISED`), which latches and reports like an injected one. No phase loss, earth fault or contactor delay.
- **Servo drive and motor:** an ideal trapezoidal profile under the velocity, acceleration and deceleration limits, in generic position units; the motor's shaft follows it exactly and its current is a holding share plus a share proportional to the velocity. No current loop, torque, inertia or homing.
- **Encoder:** pulses from a motor's speed (integrated) or a servo motor's position; absolute is single-turn. No quadrature, index pulse or multi-turn.
- **PID controller:** an ideal parallel PID on the fixed step, derivative on the measurement, the integral clamped against windup and reset on enable; `REVERSE` action for heating (output rises when the process value is below the setpoint), `DIRECT` for cooling; manual passes the manual output through; the process value is read as the measured device shows it now. No auto-tuning, setpoint ramps, bumpless transfer or output rate limits.
- **Signal conditioner:** a linear mapping of the input range onto the output range, clamped. No lag, noise or isolation error.
- **Pneumatic cylinder:** constant rod speed each way; a single-acting cylinder springs back when extend drops or air is lost, a double-acting one holds. No cushioning, pressure, load or leakage.

A behaviour can raise a fault of its profile from its own physics (`Context.Raise`, the motor starter's overload) and release it when the cause is gone; the simulation applies it after the step like an injected fault (`FAULT_RAISED` / `FAULT_CLEARED` events), so latching, reporting and quality follow the fault definition and the PLC sees it only through feedback (TASK-1014 builds on this). Quality is reported by any observer that has one (`Qualified`: sensors, encoders, signal conditioners).

Step order of the runtime since TASK-1011: what supplies a motor (drives, relays, starters) and servo drives, then motors and servo motors, then loads, then controllers, then valves, heaters, indicators, cylinders and everything else that acts, then what observes (sensors, switches, encoders, signal conditioners), in configuration order within a stage. A controller reads its transmitter's value from the previous step and the devices it controls take its output in the same step; a conditioner reads a transmitter configured before it in the same step.

### Faults, failures and degraded quality (TASK-1014)
Every fault of every profile, in the server's simulator and in the runtime, has the same shape and the same handling; the contract states each one with its reset rule, its effect and its quality (`BehaviorFault`), and nothing is implicit.

- **Injecting** a fault makes its condition present from the next step; **clearing** ends the condition. A behaviour may raise and release a fault from its own physics the same way (the motor starter's thermal overload, TASK-1011), and the events say which happened: `FAULT_INJECTED` / `FAULT_CLEARED` for a tester, `FAULT_RAISED` / `FAULT_CLEARED` with `by: model` for the model. Injecting an active fault or clearing an absent one is refused (`fault-active`, `fault-not-active`).
- **Latching is the profile's statement**, which the catalog may override per model (`DeviceFaultDefinition.resetBehavior`). A latching fault trips the device; the trip outlives the cause and ends only on a rising edge of the PLC's `faultReset` signal or the operator's reset (`DEVICE_RESET`), refused while the cause is present. A non-latching fault ends with its cause. A power cycle (OFFLINE ending) also ends a trip, as it does on real equipment.
- **A silent fault** is one the device cannot report on its own `faulted` output: a stuck valve or cylinder, a welded contact, disagreeing limit or end sensors, a lost supply. The PLC sees the effect in the feedback and decides in its logic; the simulator never raises a flag the real device would not have.
- **Quality** is the trust in a device's feedback, `GOOD` or `BAD`: BAD while a fault the profile names as bad-quality is present (a transmitter's `BAD_QUALITY`, an encoder's `SIGNAL_LOSS`, a conditioner's `OPEN_INPUT`), while the device is unavailable (`OFFLINE`) or unreachable (`COMM_LOSS`), while the runtime has set it aside (`FAULTED`, `QUARANTINED`), and **while the device it measures is BAD**: quality travels along `measures` links (a transmitter on an unavailable pump, a conditioner on such a transmitter). Each change is a `QUALITY_CHANGED` event (`from`, `to`, `activeFaults`), and the bridge carries the quality to the feedback tags (`feedbackQuality`), so the Live Tags screen and the PLC's program see the value as untrusted rather than as a healthy zero.
- **Faults act on feedback only.** Nothing here writes a PLC output; commands keep landing on an unavailable device and do nothing until it is back. The PLC decides what to do with what it reads.

Two faults are generic and belong to every device, declared once and appended to every profile and every served device:

| Code | Belongs to | Effect |
|---|---|---|
| `OFFLINE` (device unavailable: lost supply, disconnected, powered down) | every profile, last in its fault list | not stepped; every output reads de-energized (false / 0), as powered-down wiring reads; quality BAD; its physics is wiped at once, so a motor it feeds coasts, a heater its contactor switches goes cold, a servo motor loses its drive; it restarts from its initial state, untripped, when the fault ends. Silent, non-latching, critical. |
| `COMM_LOSS` (communication lost) | every device served over a protocol (the register map's fault, TASK-1013) | the runtime answers nothing for its unit id (exception `0B`); the behaviour goes on; quality BAD. Silent, non-latching, critical. |

The examples of the phase map onto the standard as follows: communication loss → `COMM_LOSS`; bad quality → `BAD_QUALITY`, `SIGNAL_LOSS`, `OPEN_INPUT` and the propagation; stuck sensor or value → `STUCK`; overload, overcurrent, overtemperature, drive trip and motor fault → the latching trips of the drives, starters, motors and heaters; dry run → `DRY_RUN`; stuck valve or actuator → `STUCK`; limit-switch disagreement → `LIMIT_SWITCH_FAULT` of a valve and `END_SENSOR_FAULT` of a cylinder; controller or device unavailable → `OFFLINE`. Every catalog model the simulator runs lists `OFFLINE` among its faults, so the simulator screen can inject it; a vendor model lists it without a source, because it is Z-Factory's generic fault and not a vendor's claim.

### Protocol-controlled devices (TASK-1013, ADR-0027)
A device the PLC commands over a network instead of terminals runs the same behaviour
profile behind a **declared register map**: one signal of the profile per register, in
the area its direction and kind dictate (commands as coils, setpoints as holding
registers, boolean feedback as discrete inputs, numeric feedback as input registers),
with data type, scale, unit, access and role, and the signal's range on every writable
register. Maps are stated in `lib/domain/register-maps.ts` and declared identically in
the runtime (`internal/device/registers.go`), which serves them over Modbus TCP, one
listener per factory, each device at its unit id; the parity test holds the two together
and `docs/process-simulation.md` → Register maps and the Modbus listener has the request
rules. Writes set the behaviour's inputs only on writable registers and within range,
reads return commands as written and feedback as produced, and everything else answers a
Modbus exception before the device is touched. The PLC stays the authority: the runtime
takes what the PLC writes to the device and never writes a PLC output.

The one shipped map is the generic Modbus drive's, Z-Factory's own declaration for the
generic model, not any vendor's:

| `VFD_MODBUS_TCP` v1 (profile `VFD` v1) | Area | Address | Type | Access | Role |
|---|---|---|---|---|---|
| `run` | coil | 0 | BOOL | read / write | command |
| `reverse` | coil | 1 | BOOL | read / write | command |
| `faultReset` | coil | 2 | BOOL | read / write | command |
| `frequencySetpoint` (0.1 Hz; 0 … `maxFrequencyHz`) | holding register | 0 | UINT16 | read / write | setpoint |
| `running` | discrete input | 0 | BOOL | read only | status |
| `atSetpoint` | discrete input | 1 | BOOL | read only | status |
| `faulted` | discrete input | 2 | BOOL | read only | alarm |
| `actualFrequency` (0.1 Hz) | input register | 0 | UINT16 | read only | feedback |
| `outputCurrent` (0.1 A) | input register | 1 | UINT16 | read only | feedback |

Zero-based addresses, big-endian, high word first; engineering value = raw × scale.
A vendor drive's register map would be a vendor fact with its source (TASK-1012); none is
declared, and the catalog refuses a model that names a map that is not declared. The
generic Modbus drive of the catalog names this map and stays `NOT_SIMULATABLE` until
TASK-1015 moves factories to the runtime and gives the PLC a path to the listener; a
remote I/O station and a gateway have no profile (`docs/device-catalog.md`).

### As built (TASK-1009, ADR-0025)
The catalog device runtime is part of `services/process-sim`: behaviour profiles in
`internal/device` (the ten behaviours above, ported value for value, each described over
`GET /v1/profiles`), the factory simulation that couples them (`simulation.go`: links by
role, the fixed step order, faults, trips, forcing, events), and the host of many
factories in `internal/runtime` (one goroutine per factory, a faulting or slow behaviour
set aside without stalling the others, bounded devices and events, stall detection). The
contract, routes, rules and limits are in `docs/process-simulation.md` → Catalog device
runtime. Z-Factory reaches it through `client.devices` in
`lib/runtimes/process-sim/client.ts`, and `lib/runtimes/process-sim/devices.ts` turns the
server simulator's configuration into the runtime's (profile from `DEVICE_PROFILES`,
links from the relationships). Factories still run on the server's simulator until
TASK-1015.
