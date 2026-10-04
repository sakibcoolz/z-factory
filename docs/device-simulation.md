# Device Simulation

## Purpose
Model industrial peripheral behavior around the PLC so Z-Factory can execute an end-to-end control loop rather than only expose PLC tags.

## Runtime strategy
Use a shared device-simulator engine/process for ordinary peripherals. It hosts many factory-specific device state machines. Do not create one container per simple device by default.

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

Do not persist every tick by default.

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
