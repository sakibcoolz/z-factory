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
- Docker Engine integration implemented (TASK-201 done): server-only policy-checked network and container lifecycle with an image allow-list, tested against a real engine.
- OpenPLC runtime adapter implemented (TASK-202 done, ADR-0009): Structured Text is compiled with STruC++, deployed to the official OpenPLC Runtime v4 container and executed; program versions, runtime metadata, state and events are persisted; raw tag access over Modbus TCP works. Operated from the PLC screens since TASK-305.
- Modbus tag mapping implemented (TASK-203 done): tag registry with derived Modbus addresses, typed read/write with permissions by role, command records, and a configurable, validated host endpoint per PLC. Typed tag reading and writing has no screen yet (Live Tags, TASK-401).
- Device simulator implemented (TASK-204 done, ADR-0010): shared in-process simulator for VFD, motor, pump and other motor-driven loads, valve, sensor and switch; PLC bridge over Modbus; fault injection, reset and forced inputs; events and snapshots. Closed loop verified against a real OpenPLC runtime. Operated from the simulator screen since TASK-305.
- Phase 02 complete.
- Program, versions, runtime and simulator screens implemented for stored PLCs (TASK-305 done): edit, check, save and deploy Structured Text; versions and deployment snapshots; start, deploy, restart, stop and remove the OpenPLC runtime with its state and failures; start and stop the device simulation with live device states and fault injection. Verified in a browser and against a real OpenPLC runtime.
- PLC engineering export implemented (TASK-304 done): one normalized document per PLC rendered as a printable 15-section report, a JSON file and three CSV schedules, with a configuration revision and a redaction check.
- Factory designer implemented (TASK-303 done): React Flow canvas for stored factories with a catalog palette, saved positions, typed and validated connections, a state overlay and a read-only topology view.
- PLC configuration implemented (TASK-302 done): create a compact or modular PLC from the catalog, install modules, wire peripherals to channels with tags and Modbus addresses, data-driven pin view and I/O mapping for stored factories.
- Device catalog implemented (TASK-301 done): four PLC targets and eight I/O modules verified against manufacturer documents with stored provenance, 26 generic simulated models, 35 categories, compatibility filtering, and the catalog screen reading the database.
- Events and live telemetry implemented (TASK-401 done, ADR-0011): one ordered recording path for runtime events, alarms with acknowledgement, a tag monitor reading running PLCs, sampled telemetry with retention, and a server-sent event stream with replay after a reconnect. Live Tags and Events screens read live data for stored factories; designer, topology and runtime screens follow the stream. Verified in a browser and against a real OpenPLC runtime.
- The 3D view still reads fixtures; container logs are not shown.
- Post-MVP process-module architecture documented: generic devices remain catalog-backed, while process modules compose factory devices and allocate module-specific PLC I/O.
- Phase 06 includes TASK-605 for an authoritative module PLC I/O registry.
- ADR-0008 accepts a separate Go process-simulation service in Phase 06+ only; it does not alter current MVP Phase 02–05 implementation.
- Phase 07 is now PLC-to-PLC Communication. It plans independent PLC containers/programs exchanging explicitly mapped data over Modbus TCP.
- PLC-to-PLC writes are limited to configured writable command/setpoint endpoints; target PLC local logic remains authoritative.
- Cross-factory PLC-to-PLC links are out of scope for Phase 07.

## Planning gate
Phase task Markdown remains the execution unit. Existing Linear Phase 00–05 items remain synchronized. Newly documented Phase 06–07 tasks, including TASK-605 and TASK-701–704, must be mirrored to Linear before either phase becomes active. Phase 00 is closed.

## Next technical gate
TASK-401 is done. The rest of Phase 04 is the 3D work: TASK-402 (factory view, ready), TASK-403 (catalog assets) and TASK-404 (live state in 3D, which consumes the stream of TASK-401). Before TASK-402 starts: decide which task owns the catalog asset reference and its schema, where GLB files are stored (an ADR), and mirror TASK-403 and TASK-404 to Linear.
