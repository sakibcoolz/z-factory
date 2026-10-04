# TASK-102 — Prisma & Domain Foundation

Status: **PLANNED**
Linear: pending

## Objective
Implement PostgreSQL/Prisma persistence for the domain described in `docs/database.md`.

## Scope
Manufacturer/category/family/model catalog, electrical/comms/I/O metadata, compact I/O, modular racks/modules/compatibility, factories, factory-specific device instances, tags, PLC I/O points, typed device connections, gateway mappings, program/config versions, runtime ports, simulation profiles, commands, runtime snapshots, events, alarms and telemetry samples.

## Acceptance criteria
- Prisma schema and initial migration.
- Unique device name per factory.
- Catalog definition and factory instance are separate entities.
- Command/setpoint vs feedback/status tag roles are represented.
- VFD -> primary motor relationship invariant can be enforced.
- Seed strategy separated from vendor-source ingestion.
- Repository/domain-service layer.
- Zod validation at boundaries.
- Unit tests for compact/modular and connection invariants.
- Any schema deviation is reflected in `docs/database.md`.
