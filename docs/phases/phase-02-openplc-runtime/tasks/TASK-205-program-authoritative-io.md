# TASK-205 — Program-Authoritative I/O Semantics & Physical Target Boundary

Status: **PLANNED**
Linear: [ZFA-38](https://linear.app/recruit-verse/issue/ZFA-38)

## Objective
Align the OpenPLC simulation and future physical-PLC deployment model with industrial PLC semantics: the PLC scan cycle owns local outputs; Modbus is used for external commands, setpoints, monitoring and simulation bridging, not as the normal mechanism for driving local output pins.

## User stories
- As an engineer, a PLC program drives its configured local outputs from logic exactly as it would on a physical PLC.
- As a simulator user, field inputs can be injected into the virtual PLC without pretending those writes are physical output control.
- As an integrator, a gateway writes command/setpoint tags and observes feedback, while PLC logic decides the final outputs.
- As a future physical-target user, the same logical program can be mapped to real hardware I/O through a target adapter without requiring Modbus for local I/O.

## Scope
- Separate program-driven local I/O from externally writable command/setpoint memory.
- Audit tag roles and write permissions so local physical output tags are not exposed as normal external writable controls.
- Keep simulation input injection behind a dedicated simulator/runtime bridge.
- Keep output observation available for the device simulator and telemetry.
- Document target-specific physical I/O mapping as an adapter concern.
- Preserve explicit Modbus remote-I/O/device scenarios where the actual topology uses Modbus.

## Required control paths
### Simulated local I/O
```text
Simulated sensor/process
 -> simulation bridge
 -> PLC input image / simulation input memory
 -> PLC program
 -> PLC output image
 -> device simulator
 -> feedback/process value
 -> PLC input image
```

### Remote command
```text
UI / gateway
 -> command or setpoint tag
 -> PLC program
 -> PLC local output
 -> device
```

### Physical PLC
```text
physical input module
 -> PLC input image
 -> PLC program
 -> PLC output image
 -> physical output module
```

## Acceptance criteria
- Normal UI/gateway writes cannot directly drive a local PLC output pin.
- Command/setpoint tags remain externally writable where configured.
- Program-generated output state remains readable for telemetry/simulation.
- Simulation bridge can inject process/input values without changing control authority.
- Documentation clearly distinguishes REST runtime management, Modbus external/simulation transport and PLC scan-cycle local I/O.
- Future physical-target adapter contract is documented.
- Tests cover rejection of direct normal-control writes to local output endpoints.
- ADR-0015 is referenced by architecture/runtime/gateway docs and AGENTS.md.
