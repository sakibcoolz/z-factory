# TASK-102 — Prisma & Domain Foundation

Status: **DONE**
Linear: [ZFA-5](https://linear.app/recruit-verse/issue/ZFA-5)

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

## Evidence (2026-10-04)
- Prisma schema (`prisma/schema.prisma`, 34 models) and migrations `init` + `device_io_endpoint`; CHECK/EXCLUDE invariants in the migration SQL, listed in `docs/database.md`. Prisma Migrate reports no drift after them.
- Unique device name per factory: `@@unique([factoryId, name])`, surfaced as a `CONFLICT` domain error.
- Catalog vs instance: separate tables; catalog rows are `RESTRICT`-protected, factory rows cascade.
- Command/setpoint vs feedback: `TagRole` plus `Tag_writable_role_check` / `Tag_writable_area_check`.
- VFD → primary motor: `assertConnectionAllowed` in the service and two EXCLUDE constraints in the database.
- Seed: `prisma/seed.ts` seeds 17 generic categories only; vendor ingestion stays with TASK-301.
- Layers: repositories in `lib/db/repositories/`, services in `lib/services/` (`createDeviceInstance`, `connectDevices`), pure rules in `lib/validation/`, typed errors in `lib/domain/errors.ts`.
- Zod at the boundary: `lib/validation/schemas.ts` (factory, device instance, connection, subnet, slug, names) and `lib/env.ts`.
- Tests: 69 new tests. Unit: compact/modular rules, module placement, signal compatibility, drive/motor rules, tag access and register overlap, schemas, error translation, domain↔database enum parity. Integration (PostgreSQL, 14 tests): unique names, catalog/instance separation, PLC profile creation, one VFD → one motor at service and database level, compatible/incompatible/occupied wiring, foreign-PLC I/O point, writable-feedback rejection, I/O point source check, owner scoping.
- `npm run format:check`, `npm run lint`, `npm run typecheck`, `npm test` (109 tests), `npm run build` pass.

## Deviations from the original `docs/database.md` (now documented there)
- Added provenance fields `verificationStatus`, `sourceTitle`, `sourceRetrievedAt` on `DeviceModel` and `ModuleModel` (source policy).
- Added `Factory.description`, `Tag.plcIoPointId`, `Tag.offset`, `RuntimeEvent.version`.
- Added endpoint type `DEVICE_IO` so a peripheral terminal is an explicit connection endpoint.
- Defined the rack/module tables and `SimulationProfile` columns the document only named.

## Not in this task
- Factory services and UI (TASK-103), I/O point generation and module placement services (TASK-302), Modbus mapping generation (TASK-203). The pure rules they need already exist in `lib/validation/`.
