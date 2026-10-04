# TASK-102 — Prisma & Domain Foundation

Status: **PLANNED**
Linear: pending

## Objective
Implement PostgreSQL/Prisma persistence for the domain described in `docs/database.md`.

## Scope
Catalog, manufacturer/family/model, electrical/comms metadata, compact I/O, modular racks/modules/compatibility, factories, instantiated devices, tags, connections, runtime ports, simulation profiles, runtime events.

## Acceptance criteria
- Prisma schema and initial migration.
- Seed strategy separated from vendor-source ingestion.
- Repository/domain-service layer.
- Zod validation at boundaries.
- Unit tests for compact/modular invariants.
- Any schema deviation is reflected in `docs/database.md`.
