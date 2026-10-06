# TASK-205 — Program-Authoritative I/O Semantics & Physical Target Boundary

Status: **DONE**
Linear: [ZFA-38](https://linear.app/recruit-verse/issue/ZFA-38)

## Objective
Align the OpenPLC simulation and future physical-PLC deployment model with industrial PLC semantics: the PLC scan cycle owns local outputs; Modbus is used for external commands, setpoints, monitoring and simulation bridging, not as the normal mechanism for driving local output pins.

## User stories
- As an engineer, a PLC program drives its configured local outputs from logic exactly as it would on a physical PLC.
- As a simulator user, field inputs can be injected into the virtual PLC without pretending those writes are physical output control.
- As an integrator, a gateway writes command/setpoint tags and observes feedback, while PLC logic decides the final outputs.
- As a future physical-target user, the same logical program can be mapped to real hardware I/O through a target adapter without requiring Modbus for local I/O.

## Scope
- Separate program-driven local I/O from externally writable command/setpoint memory.
- Audit tag roles and write permissions so local physical output tags are not exposed as normal external writable controls.
- Keep simulation input injection behind a dedicated simulator/runtime bridge.
- Keep output observation available for the device simulator and telemetry.
- Document target-specific physical I/O mapping as an adapter concern.
- Preserve explicit Modbus remote-I/O/device scenarios where the actual topology uses Modbus.

## Required control paths
### Simulated local I/O
```text
Simulated sensor/process
 -> simulation bridge
 -> PLC input image / simulation input memory
 -> PLC program
 -> PLC output image
 -> device simulator
 -> feedback/process value
 -> PLC input image
```

### Remote command
```text
UI / gateway
 -> command or setpoint tag
 -> PLC program
 -> PLC local output
 -> device
```

### Physical PLC
```text
physical input module
 -> PLC input image
 -> PLC program
 -> PLC output image
 -> physical output module
```

## Acceptance criteria
- Normal UI/gateway writes cannot directly drive a local PLC output pin.
- Command/setpoint tags remain externally writable where configured.
- Program-generated output state remains readable for telemetry/simulation.
- Simulation bridge can inject process/input values without changing control authority.
- Documentation clearly distinguishes REST runtime management, Modbus external/simulation transport and PLC scan-cycle local I/O.
- Future physical-target adapter contract is documented.
- Tests cover rejection of direct normal-control writes to local output endpoints.
- ADR-0015 is referenced by architecture/runtime/gateway docs and AGENTS.md.

## Implementation (2026-10-06)
Design: docs/openplc-runtime.md → As built (TASK-205) and Physical target adapter (contract);
docs/architecture.md → PLC I/O authority boundary.

- `lib/domain/tag-authority.ts` — `tagAuthority`: every tag has one owner
  (`PROGRAM_OUTPUT`, `PROGRAM_INPUT`, `SIMULATION_FEEDBACK`, `EXTERNAL_COMMAND`,
  `PROGRAM_INTERNAL`); `isExternallyWritable` is the single rule for normal control writes.
- Enforcement: `writeTag` and the Live Tags write control use `isExternallyWritable`;
  `writePlcRegister` (raw Modbus write) accepts an address of external command memory only
  and refuses everything else with `program-authority`, naming the owner; `createTag` refuses a
  writable tag on an I/O point (`io-point-read-only`, on top of `io-point-address`); migration
  `20261006180000_io_point_tags_read_only` adds `Tag_io_point_read_only_check`. The gateway's
  `gateway-write-command-only` rule and the bridges' `signal-address` rule were already in place.
- Visibility: `authority` on every Modbus map row, in the engineering export (JSON and the tag
  CSV, "Driven by") and as a "Driven by" column on the Live Tags screen.
- Documentation: owner table and enforcement list, the physical target adapter contract,
  API contract, database constraint, gateway and simulation notes, design, testing, status.

## Evidence
- `lib/domain/tag-authority.test.ts` (4 tests).
- `test/integration/program-authority.test.ts` (5 tests, PostgreSQL): owners in the map,
  the live tags and the export; UI and gateway writes to a local output, an alarm and
  simulated feedback refused as `tag-read-only` and recorded as `COMMAND_REJECTED`; raw
  register writes refused on an output, an input, program memory and a bare address,
  accepted on command memory up to the stopped runtime; a command tag at a channel's
  address refused and the database refusing to make a channel tag writable; a gateway reads
  but never writes a local output, "map all" included.
- `test/integration/plc-runtime.test.ts` (Docker, real OpenPLC): raw write refused without a
  tag and on a program output, accepted on a command tag; the program reacts.
- Existing suites (gateway, simulation, process bridge, export, live) unchanged in behaviour.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 87 files, 971 tests passed
  (225 s); no test container or network left behind.
- Browser: the Live Tags screen shows the "Driven by" column (headless Chromium against
  `next start`, the owner's factory read only).
- Dev database: migration `io_point_tags_read_only` applied.
- Graphify refreshed: 4130 nodes, 10895 edges, 226 communities.
