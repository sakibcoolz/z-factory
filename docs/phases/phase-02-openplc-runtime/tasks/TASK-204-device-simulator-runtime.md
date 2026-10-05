# TASK-204 — Device Simulator Runtime

Status: **DONE**
Linear: [ZFA-11](https://linear.app/recruit-verse/issue/ZFA-11)

## Goal
Implement the shared device-simulator runtime used by factory-specific VFD, motor, pump, valve, sensor and switch instances.

## Scope
- Runtime adapter/service boundary
- Per-device in-memory state keyed by factory/device instance
- Configurable simulation tick
- VFD ramp/run/fault model
- Motor response model
- Pump/process feedback model
- Sensor/switch/valve base behaviors
- Events for meaningful state/value/fault changes
- Runtime snapshot hooks without persisting every tick

## Invariants
- PLC logic remains the control authority.
- One VFD -> one primary motor for MVP.
- Simulator state is live authority; PostgreSQL is durable history/config.
- No unsupported claims of exact physics/manufacturer fidelity.

## Acceptance
- Multiple VFD/motor/pump chains can run independently in one shared simulator runtime.
- PLC commands change simulator state and feedback is readable through defined mappings.
- Fault injection/reset and event emission are tested.

## Evidence (2026-10-05)
- **Shared runtime, independent chains.** One `DeviceSimulatorRuntime` hosts every factory; each factory has its own devices, PLC bridge and tick (`lib/runtimes/device-sim/`). Unit tests run three VFD → motor → pump chains in one simulation and two factories in one runtime without interference.
- **PLC commands change simulator state; feedback is readable through defined mappings.** A tag with `sourceDeviceInstanceId` + `sourceSignal` wires a device signal. Against a real OpenPLC runtime, a Structured Text program starts the drive, the simulated drive ramps, motor speed and pump pressure follow, and the program reads them back through its tags and trips on high pressure.
- **PLC logic stays the control authority.** A device signal cannot be wired to a gateway-writable tag; gateway writes to program-driven tags are refused; with the PLC stopped the devices are de-energized.
- **One VFD → one primary motor.** Enforced by the connection rules and database (TASK-102) and again when a simulation is built.
- **Models.** VFD ramp/run/reverse/fault, motor response and current, pump flow/pressure and other motor-driven loads, valve travel and limit switches, sensor sources (constant, ramp, sine, random, measured) with lag and range, switch with hysteresis. Approximations are documented in `docs/device-simulation.md`.
- **Fault injection/reset and events.** Latching and non-latching faults, reset by the PLC's `faultReset` signal or by the operator, forced sensor/switch values; each is stored as a `RuntimeEvent`. State changes, faults and PLC-link changes emit events; nothing is emitted or stored per tick.
- **Snapshots.** One `DeviceRuntimeSnapshot` row per device at the snapshot interval and on stop.
- Tests: 34 engine, 13 bridge/runtime, 8 service tests against PostgreSQL with an in-process Modbus server, 6 closed-loop tests against a real OpenPLC runtime. 341 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.

## Decisions (ADR-0010, accepted)
- The simulator runs inside the server process and reaches PLCs through their published Modbus endpoints. No simulator container.
- Simulated feedback is delivered to memory addresses (`%M`): the OpenPLC runtime does not accept external values on `%I`. Programs read simulated feedback from memory variables.

## Schema change
- `Tag.sourceSignal` (nullable) with a unique index on `(sourceDeviceInstanceId, sourceSignal)`; migration `tag_source_signal`. The register-map contract gained `sourceSignal`.

## Not in this task
- No screen uses the simulation services yet.
- Simulations are not resumed after a server restart; factory start/stop orchestration is a later task.
- Device faults do not raise `AlarmEvent` rows; no telemetry sampling; no SSE transport (the event bus exists).
- Relays and contactors are not simulated; a motor drives one load.
