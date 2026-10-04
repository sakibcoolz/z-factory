# TASK-601 — Process Module Domain & Persistence

Status: **PLANNED**

## Goal
Add the reusable process-module domain without mixing process-specific concepts into the generic device catalog.

## Scope
- ProcessModuleType and ProcessModuleInstance
- ModuleDevice role assignment
- ModuleSignalDefinition logical I/O contract
- ModulePlcIoMapping
- ModuleInterlock metadata
- ownership, naming and factory-scoping rules
- schema migration, repositories, validation and tests
- update database/API documentation

## Invariants
- Process modules reference existing factory DeviceInstances; they do not duplicate device models.
- Module I/O allocation must reuse normal PLC I/O/tag compatibility and occupancy validation.
- Process role is separate from manufacturer/model identity.
- No boiler-specific fields belong in the generic schema beyond extensible module configuration.

## Acceptance
- A factory can create multiple uniquely named process-module instances.
- Devices can be assigned to typed module roles.
- Logical module inputs/outputs can be bound to valid PLC tags/I/O points.
- Invalid cross-factory device assignment and incompatible I/O mappings are rejected.
- Tests cover persistence and validation invariants.
