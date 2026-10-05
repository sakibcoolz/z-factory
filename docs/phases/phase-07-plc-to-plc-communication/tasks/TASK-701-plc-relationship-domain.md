# TASK-701 — PLC Relationship & Communication Domain

Status: **PLANNED**
Linear: [ZFA-29](https://linear.app/recruit-verse/issue/ZFA-29)

## User story
As a Z-Factory engineer, I want to define a communication relationship between two PLC instances so that one PLC can coordinate, monitor or exchange data with another PLC without merging their programs or runtimes.

## Scope
- source PLC and target PLC
- relationship type: `COMMUNICATES_WITH` or `SUPERVISES`
- protocol selection
- logical role metadata: client/server
- enable/disable state
- same-factory validation
- configuration versioning
- repositories, validation and tests

## Invariants
- Source and target must be different PLC instances.
- Both PLCs must belong to the same factory in this phase.
- A relationship does not imply unrestricted write access.
- Each PLC retains its own program, container, lifecycle and local control logic.

## Acceptance
- PLC relationships can be created, updated, listed and removed.
- Self-links and cross-factory links are rejected.
- Relationship configuration is versioned and exportable.
