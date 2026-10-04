# Project Status

Last architecture documentation update: 2026-10-04

## Current state
- Repository initialized on `develop`.
- Documentation-first foundation created.
- Primary database selected: PostgreSQL + Prisma.
- Core runtime selected: OpenPLC in reusable Docker containers.
- MVP protocol selected: Modbus TCP.
- Factory isolation rule defined: one Docker network per factory by default.
- Compact vs modular PLC model defined.
- Factory-specific industrial device instance/catalog model separation defined.
- Device simulation model defined for VFDs, motors, pumps, valves, sensors, switches and related devices.
- Gateway command path defined: gateway -> PLC command/setpoint -> PLC logic -> device simulation.
- Live-state vs persistence boundary defined.
- PLC engineering export/print requirement defined.
- Phase 00 complete: bootstrap specification in `docs/bootstrap.md`.
- Next.js application bootstrapped (TASK-101 done): format, lint, typecheck, tests and build pass; CI workflow defined.
- PostgreSQL/Prisma domain foundation implemented (TASK-102 done): 34-model schema, database-enforced invariants, repositories, device/connection services, Zod boundary schemas, generic category seed.
- UI shell and all 17 wireframe screens implemented over static design fixtures (TASK-104 in progress). No persistence, Docker, OpenPLC, Modbus or live data behind them yet.
- Factory CRUD implemented (TASK-103, pending acceptance of ADR-0007): the Factories, Create Factory, overview and edit screens read and write the database behind the `requireActor()` boundary.
- The remaining screens still read fixtures: Docker, OpenPLC, Modbus and live data are NOT STARTED.

## Planning gate
Phase task Markdown remains the execution unit. Linear is synchronized: team `z-factory` (ZFA), project Z-Factory, one milestone per phase and one issue per task (ZFA-1 … ZFA-19). Phase 00 is closed.

## Next technical gate
Accept ADR-0007 (single-owner mode) to close TASK-103, and review TASK-104, to finish Phase 01. Then Phase 02 starts with TASK-201 (Docker Engine integration). After Phase 01, implement catalog/factory entities before Docker/OpenPLC runtime work.
