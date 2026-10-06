# Testing Strategy

## Layers
- Unit: domain rules, mappings, codecs, validators, compatibility and simulator state machines.
- Component: compact/modular forms, peripheral picker, I/O occupancy, topology and export views.
- Integration: PostgreSQL/Prisma, Docker adapter, OpenPLC runtime, program deploy/reload, Modbus mapping, shared device simulator.
- End-to-end: factory creation -> PLC program execution -> device response -> live telemetry -> external Modbus command/readback -> PLC export.

## Mandatory high-risk tests
- Docker options cannot escape the allow-list.
- Port/subnet collisions.
- Compact/modular rack/module/I/O compatibility.
- Duplicate PLC endpoint assignment is rejected.
- Modbus address collisions and typed codec/byte-order behavior.
- Command/setpoint tags cannot be confused with feedback/status permissions.
- Gateway writes flow through PLC logic rather than directly mutating simulator state.
- VFD ramp/state/fault behavior and one-VFD-to-primary-motor invariant.
- Motor/pump/valve/sensor simulator state transitions.
- Runtime vs persisted-snapshot boundary.
- Runtime crash/disconnect/stale-value handling.
- External connectivity only through intended published ports.
- PLC export contains required engineering data and excludes secrets.

## End-to-end reference scenario
Pressure/level sensor -> OpenPLC logic -> VFD -> motor -> pump/process -> feedback tags; external edge gateway writes a setpoint/command and reads actual feedback; UI displays live state and an engineering export is generated.

### As automated (TASK-502)
`test/integration/e2e-demo.test.ts` runs this scenario against a real OpenPLC runtime (`TEST_DOCKER=1`): the pump station demo is built from the catalog and started as a factory; an edge client at the gateway endpoint writes the start command and the speed setpoint and reads actual frequency and pressure; the high-pressure interlock trips and is reset; a drive fault is injected and cleared; recorded commands, events, alarms and sampled telemetry are checked; the engineering export is produced; the factory is stopped. The manual version is `docs/demo-runbook.md`.

## Definition of Done
Relevant tests pass locally/CI; new behavior has tests; failures and evidence are recorded in the task file.


## Process simulation (Phase 06+)
Advanced process models require deterministic tests with fixed configuration, initial state, command sequence and time steps. Cover model bounds, repeatability, PLC command/feedback mapping, scaling/data types, disconnect/stale quality, and integration with OpenPLC.

As built (TASK-602): the service's own tests (`go test -race ./...` in `services/process-sim`) cover the model contract, repeatability (the same configuration and steps give byte-equal outputs and state), the dynamics and bounds of each model, the lifecycle (load, start, step, stop, continue, reset, unload, shutdown) and the HTTP API with its authentication and refusals. `test/integration/process-sim.test.ts` starts the built binary (`PROCESS_SIM_BIN`), drives it through the server's client, and restarts it to prove the service starts empty.

As built (TASK-603): `lib/domain/process-bridge.test.ts` covers every mapping rule (direction, PLC-driven tags, addresses, data types, scaled ranges, units, duplicates, register overlap, required signals, profiles). `lib/runtimes/process-bridge/runtime.test.ts` runs the bridge against an in-memory PLC and a stand-in service: lockstep stepping, command and setpoint in and scaled/typed feedback out, change-only writes, the model's events once each, alarms derived from ALARM signals, `DISCONNECTED` with de-energized commands and recovery, `STALE` with kept values and reload after the service forgot the instance, refused loads rolled back, two modules on one PLC kept apart. `test/integration/process-bridge.test.ts` plans from stored modules and tags (settings, bindings, every refusal, other owners, incomplete modules, types without a model, the start blockers). `test/integration/process-bridge-runtime.test.ts` closes the loop with the built service and a real OpenPLC runtime (`TEST_DOCKER=1 PROCESS_SIM_BIN=…`): the program commands, the process value is read at the PLC as a REAL, the model's alarm reaches the PLC and the alarm log, the program's interlock trips on the process value and the pump stops, a gateway cannot write what the program or the process produce, the module goes `DISCONNECTED` when the PLC stops, the bridge stops cleanly, and `startFactory`/`stopFactory` run it from the stored bindings.

As built (TASK-605): `lib/domain/module-io-view.test.ts` builds the registry rows (states, blocking, counts, per-PLC use, invalid bindings, profiles). `test/integration/module-io.test.ts` covers the registry on PostgreSQL: the unbound list and what blocks, candidates with refusals, bind/rebind/release, every refusal (incompatible, held by another signal or module, bound, other owner), two bindings racing for one tag (exactly one wins), bindings turning INVALID when their tag changes and vanishing with the tag, profile changes, the factory summary, the bridge plan from stored bindings, the PLC export's module signals, and export/import (names, same type and profile, all or nothing). The OpenPLC loop test binds through the registry.

As built (TASK-604): `components/modules/module-editor.test.tsx` renders the editor, the list and the new-module form from fixtures: every registry state and what blocks the module, the picker offering only free compatible tags with the others disabled and explained, device pickers by category, interlocks, topology, export link, the bridge button off until ready and the live-values table while running; the form's fields follow the selected type. `lib/process-modules/form.test.ts` types the settings of a form by their declared kind. `app/screens.test.tsx` covers the two routes for unknown ids. The flows (assign, bind, release, import, create with a refused duplicate name, delete) were exercised in a real browser against a temporary factory.

Boiler Phase 07 tests must verify multi-zone temperature evolution and control-loop behavior without treating the model as thermodynamic or safety certification.

## Program authority (TASK-205, ADR-0015)
`lib/domain/tag-authority.test.ts` classifies tags (I/O points, `%Q`/`%I`/`%M` memory, writable commands, bridge-fed memory, module signals). `test/integration/program-authority.test.ts` (PostgreSQL) checks every door on a PLC with wired channels and command memory: the owner of each tag in the Modbus map, the live tags and the export; UI and gateway writes to a local output, an alarm and simulated feedback refused and recorded as `COMMAND_REJECTED`; raw register writes refused everywhere but external command memory; a command tag at a channel's address refused and the database refusing to make a channel tag writable; a gateway allowed to read but never write a local output. `test/integration/plc-runtime.test.ts` (Docker) exercises the raw write against a running OpenPLC runtime: refused without a tag and on a program output, accepted on a command tag.
