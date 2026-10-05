# TASK-601 — Process Module Domain & Persistence

Status: **PLANNED**
Linear: [ZFA-24](https://linear.app/recruit-verse/issue/ZFA-24)

## Goal
Add the reusable process-module domain without mixing process-specific concepts into the generic device catalog.

## Scope
- ProcessModuleType and ProcessModuleInstance
- ModuleDevice role assignment
- ModuleSignalDefinition logical I/O contract
- ModuleInterlock metadata
- ownership, naming and factory-scoping rules
- schema migration, repositories, validation and tests
- update database/API documentation

PLC endpoint allocation and the module-level consumed-I/O registry are implemented separately in TASK-605.

## Invariants
- Process modules reference existing factory DeviceInstances; they do not duplicate device models.
- Process role is separate from manufacturer/model identity.
- No boiler-specific fields belong in the generic schema beyond extensible module configuration.
- Module signal definitions describe logical process I/O; they do not reserve physical PLC endpoints by themselves.
- A module may have different optional I/O counts/configurations depending on its selected profile.

## Acceptance
- A factory can create multiple uniquely named process-module instances.
- Devices can be assigned to typed module roles.
- Module types can declare required and optional logical INPUT/OUTPUT/INTERNAL/ALARM signals.
- Invalid cross-factory device assignment is rejected.
- Tests cover persistence and validation invariants.
