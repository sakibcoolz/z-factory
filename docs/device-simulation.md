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
