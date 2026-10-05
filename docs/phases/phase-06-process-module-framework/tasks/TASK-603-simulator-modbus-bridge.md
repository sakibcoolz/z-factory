# TASK-603 — Simulator / Modbus Closed-Loop Bridge

Status: **PLANNED**
Linear: [ZFA-26](https://linear.app/recruit-verse/issue/ZFA-26)

## Goal
Connect process simulation values to OpenPLC through validated command/feedback mappings.

## Scope
- map simulator feedback/process values to PLC-readable tags/registers
- map PLC command/setpoint tags to simulator inputs
- FLOAT32/INT/BOOL codecs, scaling and engineering units
- configured tick/poll/update timing
- quality/stale/disconnected states
- event generation for meaningful state/fault changes
- end-to-end integration tests with OpenPLC

## Canonical flow
```text
Go process model -> feedback value -> Modbus/adapter -> PLC input/tag
PLC program -> command/setpoint tag -> Modbus/adapter -> Go process model
```

## Invariants
- Simulator feedback cannot overwrite PLC command/setpoint ownership.
- Writable mappings follow existing Coil/Holding Register rules.
- PLC logic owns interlocks and control decisions.
- Mapping validation prevents address overlap and incompatible data types.

## Acceptance
- A simulated numeric process value is readable by OpenPLC as a mapped tag.
- A PLC command changes the process model input and produces subsequent feedback.
- Data type, scaling, quality and disconnect behavior are covered by tests.
