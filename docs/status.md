# Project Status

Last architecture documentation update: 2026-10-06

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
- UI shell and all 17 wireframe screens implemented (TASK-104 done); their design fixtures were retired in TASK-309 once every screen read the database.
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
- 3D factory view implemented (TASK-402 done, ADR-0012): a three.js scene of a stored factory built from the same devices, connections and positions as the designer; catalog models carry versioned GLB assets stored on the server and served by the application; devices without an asset are drawn as the generic shape of their category. Assets are authored with TASK-403.
- Live runtime state in the 3D view implemented (TASK-404 done): devices and connections are coloured from the live stream with the same rules as the 2D view; a state nobody confirms is never shown as healthy. Verified in a browser against a real OpenPLC runtime and a running simulation.
- Catalog 3D asset authoring implemented (TASK-403): `npm run assets` goes from a catalog model to a registered asset (prompt from catalog metadata, Meshy generation, download, normalization, check, registration), records pending and failed jobs on the asset version, shares a file between models of one shape, and retires versions; the catalog screen shows each model's asset state. Assets are generic shapes of the kind of device, never a manufacturer's product. The owner's installation has an asset for all 30 catalog models; assets are data of an installation (ADR-0012), so a fresh clone draws generic shapes until assets are generated or copied in. A model added to the catalog later gets its asset through the same path.
- External gateway connectivity implemented (TASK-501, ADR-0013): a gateway device of a factory is connected to a PLC through a gateway endpoint, a filtering Modbus TCP listener of the server process on an allowed address and port of the host. The endpoint hands out the mapped tags only and accepts writes only for command and setpoint tags mapped as writable; a write is recorded as a command with source `GATEWAY` and decided by PLC logic. Gateways screen for stored factories, register map download for the edge device, network and firewall guidance. Verified in a browser, with a Modbus client over the host's LAN address, and in a closed loop against a real OpenPLC runtime; not yet with a physical edge device.
- End-to-end MVP demo implemented (TASK-502): "Create pump station demo" builds a stored factory from the catalog (PLC with modules, drive, motor, pump, pressure transmitter, gateway, wiring, tags and a control program with a high-pressure interlock); "Start factory" and "Stop factory" on the Runtime screen run the whole factory; `scripts/edge-client.mjs` stands in for an edge device. `docs/demo-runbook.md` is the runbook and `test/integration/e2e-demo.test.ts` the same run against a real OpenPLC runtime. Run in a browser from creation to stop; not yet with a physical edge device.
- Process-module domain and persistence implemented (TASK-601): module types as versioned reference data with profiles, typed device roles, a logical INPUT/OUTPUT/INTERNAL/ALARM signal contract and declared configuration fields; module instances of a factory with devices in roles and interlock metadata; two shipped generic types (`PUMP_HOUSE`, `TANK`). Service layer only: no screen (TASK-604), no PLC binding (TASK-605) and no process runtime (TASK-602, TASK-603) yet.
- Factory overview device hierarchy implemented (TASK-306): the overview lists devices as they are connected, each PLC as a drop-down holding the devices connected to it; built from the existing connections, nothing stored.
- Pin-to-pin wiring implemented (TASK-307, ADR-0014): the designer wires two exact endpoints at a time, with every refusal named before saving; terminals have a kind (signal, supply, 0 V, earth) and a number of wires they take; all wires of two devices are one edge; the PLC Connections screen is read-only and the add-peripheral form is gone. A wire to a PLC channel still creates its tag, so tags, simulator and export read the same wiring.
- Capability-driven device screens implemented (TASK-308): catalog models declare capabilities; a device's screens follow its exact model (Parameters, Registers, Communications for drives and controllers; Program and Versions for programmable models only); a generic RTU runs the PLC program workflow on the OpenPLC adapter; deploy and program checks refuse what a model cannot do; parameter sets are immutable configuration versions that the simulation reads. No scripting or firmware adapter exists.
- Design fixtures retired (TASK-309): `lib/fixtures/` and the fixture branches of the screens are gone; the factory explorer lists stored factories only, and an unknown id is not found.
- 3D physical conductors implemented (TASK-405): a wiring edge is drawn as one thin line per stored wire, side by side and styled by kind; a relationship that is not wiring stays one logical line. The generic drive and motor model their three phases, so the demo's motor cable shows three conductors.
- Container logs are not shown.
- Post-MVP process-module architecture documented: generic devices remain catalog-backed, while process modules compose factory devices and allocate module-specific PLC I/O.
- Phase 06 includes TASK-605 for an authoritative module PLC I/O registry.
- ADR-0008 accepts a separate Go process-simulation service in Phase 06+ only; it does not alter current MVP Phase 02–05 implementation.
- Phase 03 reopened for follow-up work: TASK-306 is done; TASK-307 (canonical pin-to-pin wiring and validation) is done; TASK-308 (capability-driven programming and configuration) is done; TASK-309 (retire the design fixtures) is done; Phase 03 is closed again.
- Since TASK-307 one canonical endpoint wiring source replaces the PLC-centric writable mapping flow. Signal I/O is single-connection by default; explicitly modeled power, 0V/COM, PE/earth and bus endpoints are shareable within metadata-defined limits.
- Phase 04 reopened for TASK-405 and closed again: 2D keeps one logical edge, while 3D renders the exact persisted conductor set (three distinct conductors for the modeled three-phase VFD-to-motor cable).
- Programming UI is capability-driven (TASK-308): a PLC or programmable RTU exposes Program and Versions; a VFD and similar controllers get Parameters and Registers; a Program screen appears only when the exact model declares programmable logic.
- Phase 07 is now PLC-to-PLC Communication. It plans independent PLC containers/programs exchanging explicitly mapped data over Modbus TCP.
- PLC-to-PLC writes are limited to configured writable command/setpoint endpoints; target PLC local logic remains authoritative.
- Cross-factory PLC-to-PLC links are out of scope for Phase 07.

## Planning gate
- New follow-up tasks are mirrored to Linear: TASK-307 = ZFA-34 (Done), TASK-308 = ZFA-35 (Done), TASK-309 = ZFA-37 (Done), TASK-405 = ZFA-36 (Done).

Phase task Markdown remains the execution unit. Linear mirrors every task of Phases 00–07: the Phase 06 tasks TASK-601–605 are ZFA-24 to ZFA-28 and the Phase 07 tasks TASK-701–704 are ZFA-29 to ZFA-32, each in its phase milestone and in the backlog (mirrored 2026-10-05). Phase 06 was started by the owner on 2026-10-05 with TASK-601; Phase 07 is not active until the owner starts a task of it. Phase 00 is closed.

## Next technical gate
Phases 00 to 05, the MVP, are done. One thing was not exercised: an external gateway on physical hardware (the gateway endpoint is verified with a software edge client and against a real OpenPLC runtime). Phase 06 is in progress: TASK-601 (process-module domain and persistence) is done; TASK-602 to TASK-605 follow, each when the owner starts it. Phase 07 is planned.
