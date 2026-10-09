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
From the device's `SimulationProfile` (`docs/database.md`); every value has a generic default. Defaults are not vendor data.

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
| SENSOR | `BAD_QUALITY` | reads bottom of range, `faulted` true, quality BAD | no |
| SENSOR, SWITCH | `STUCK` | value frozen; not reported | no |

A latching fault trips the device: it stays faulted after the cause is cleared until it is reset, by a rising edge on its `faultReset` signal from the PLC or by an operator reset. A catalog `DeviceFaultDefinition` with the same code overrides severity and latching (`MANUAL` = latching).

### Limits
- The simulator screen of a stored factory (TASK-305) starts and stops the simulation, shows each device's command and feedback signals with the tags they are wired to, and injects, clears and resets faults. Forcing a sensor or switch value has a service but no control on the screen yet.
- A simulation lives in the server process. After a server restart it is gone and has to be started again. Stored device states left over from it are corrected to stopped the next time a live screen or stream of the factory is opened (TASK-401).
- A motor drives one load; a second `MECHANICALLY_DRIVES` connection from the same motor refuses the start.
- The measured signal of a sensor is named in its profile, not on the `MEASURES` connection.
- A device fault raises an alarm (`AlarmEvent`, code `FAULT:<code>`) that ends when the fault is gone, for a latching fault when the device leaves its faulted state, and in any case when the simulation stops (TASK-401).
- Relays and contactors are not simulated.


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

This does **not** mean every vendor product is firmware-emulated. When no legal/usable vendor runtime, emulator or Docker image exists, Z-Factory runs a documented behavior profile. Model-specific values are used only when supported by authoritative catalog sources.

Every catalog model must declare one coverage state:
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
