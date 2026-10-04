# TASK-204 — Device Simulator Runtime

Status: **READY**
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
