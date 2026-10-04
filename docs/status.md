# Project Status

Last architecture documentation update: 2026-10-05

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
- Industrial intermediate/control-interface catalog scope expanded to include servo drives, soft starters, motion/process/temperature controllers, remote I/O, IO-Link masters, protocol converters, signal conditioners and gateways.
- Intermediate devices are optional: direct PLC I/O remains supported.
- Gateway command path defined: gateway -> PLC command/setpoint -> PLC logic -> device simulation.
- Live-state vs persistence boundary defined.
- PLC engineering export/print requirement defined.
- Phase 00 complete: bootstrap specification in `docs/bootstrap.md`.
- Next.js application bootstrapped (TASK-101 done): format, lint, typecheck, tests and build pass; CI workflow defined.
- PostgreSQL/Prisma domain foundation implemented (TASK-102 done): 34-model schema, database-enforced invariants, repositories, device/connection services, Zod boundary schemas, generic category seed.
- UI shell and all 17 wireframe screens implemented (TASK-104 done). Screens 2d–2q still render static design fixtures.
- Phase 01 complete.
- Factory CRUD implemented (TASK-103 done; single-owner mode per ADR-0007): the Factories, Create Factory, overview and edit screens read and write the database behind the `requireActor()` boundary.
- Docker Engine integration implemented (TASK-201 done): server-only policy-checked network and container lifecycle with an image allow-list, tested against a real engine. No runtime image is allow-listed yet, so nothing can be started.
- The remaining screens still read fixtures: OpenPLC, Modbus, device simulation and live data are NOT STARTED.
- Post-MVP process-module architecture documented: generic devices remain catalog-backed, while process modules compose factory devices and allocate module-specific PLC I/O.
- Phase 06 includes TASK-605 for an authoritative module PLC I/O registry.
- ADR-0008 accepts a separate Go process-simulation service in Phase 06+ only; it does not alter current MVP Phase 02–05 implementation.
- Phase 07 is now PLC-to-PLC Communication. It plans independent PLC containers/programs exchanging explicitly mapped data over Modbus TCP.
- PLC-to-PLC writes are limited to configured writable command/setpoint endpoints; target PLC local logic remains authoritative.
- Cross-factory PLC-to-PLC links are out of scope for Phase 07.

## Planning gate
Phase task Markdown remains the execution unit. Existing Linear Phase 00–05 items remain synchronized. Newly documented Phase 06–07 tasks, including TASK-605 and TASK-701–704, must be mirrored to Linear before either phase becomes active. Phase 00 is closed.

## Next technical gate
Phase 02 is in progress. After TASK-201, TASK-202 (OpenPLC runtime adapter) adds the first allow-listed image and starts PLC containers; it needs a choice of OpenPLC image to pin.
