# TASK-604 — Process Module Designer & Validation

Status: **PLANNED**

## Goal
Let users compose a process module from existing factory devices and allocate its PLC I/O safely.

## Scope
- module type/instance UI
- device-role assignment
- module logical I/O table
- compatible free PLC I/O/tag picker
- interlock/required-signal validation summary
- module topology visualization
- module configuration export/import contract
- tests for validation and UI states

## Invariants
- UI never invents hardware capabilities.
- Existing device and PLC compatibility/occupancy rules remain authoritative.
- Module assignment does not change device manufacturer/model identity.
- Process-specific options are driven by the selected ProcessModuleType.

## Acceptance
- User can create a module, assign existing devices, and bind all required signals.
- Occupied/incompatible endpoints are unavailable or rejected.
- Validation clearly distinguishes missing required signals from optional signals.
- Saved module configuration can be reconstructed without altering unrelated factory devices.
