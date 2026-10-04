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
- UI shell and all 17 wireframe screens implemented (TASK-104 done). Screens 2d–2q still render static design fixtures.
- Phase 01 complete.
- Factory CRUD implemented (TASK-103 done; single-owner mode per ADR-0007): the Factories, Create Factory, overview and edit screens read and write the database behind the `requireActor()` boundary.
- Docker Engine integration implemented (TASK-201 done): server-only policy-checked network and container lifecycle with an image allow-list, tested against a real engine.
- OpenPLC runtime adapter implemented (TASK-202 done, ADR-0008): Structured Text is compiled with STruC++, deployed to the official OpenPLC Runtime v4 container and executed; program versions, runtime metadata, state and events are persisted; raw tag access over Modbus TCP works. Not wired to any screen yet.
- The remaining screens still read fixtures: Modbus tag mapping, device simulation and live data are NOT STARTED.

## Planning gate
Phase task Markdown remains the execution unit. Linear is synchronized: team `z-factory` (ZFA), project Z-Factory, one milestone per phase and one issue per task (ZFA-1 … ZFA-19). Phase 00 is closed.

## Next technical gate
Phase 02 is in progress. Next is TASK-203 (Modbus mapping and external ports): typed tags on top of the runtime's fixed address mapping, write permissions by tag role, and persisted port allocation.
