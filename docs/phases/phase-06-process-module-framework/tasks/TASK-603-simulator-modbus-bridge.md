# TASK-603 — Simulator / Modbus Closed-Loop Bridge

Status: **DONE**
Linear: [ZFA-26](https://linear.app/recruit-verse/issue/ZFA-26)

## Goal
Connect process simulation values to OpenPLC through validated command/feedback mappings.

## Scope
- map simulator feedback/process values to PLC-readable tags/registers
- map PLC command/setpoint tags to simulator inputs
- FLOAT32/INT/BOOL codecs, scaling and engineering units
- configured tick/poll/update timing
- quality/stale/disconnected states
- event generation for meaningful state/fault changes
- end-to-end integration tests with OpenPLC

## Canonical flow
```text
Go process model -> feedback value -> Modbus/adapter -> PLC input/tag
PLC program -> command/setpoint tag -> Modbus/adapter -> Go process model
```

## Invariants
- Simulator feedback cannot overwrite PLC command/setpoint ownership.
- Writable mappings follow existing Coil/Holding Register rules.
- PLC logic owns interlocks and control decisions.
- Mapping validation prevents address overlap and incompatible data types.

## Acceptance
- A simulated numeric process value is readable by OpenPLC as a mapped tag.
- A PLC command changes the process model input and produces subsequent feedback.
- Data type, scaling, quality and disconnect behavior are covered by tests.

## Implementation (2026-10-06)
Design: docs/process-simulation.md → Bridge; events and quality in docs/events-telemetry.md.

- `lib/domain/process-bridge.ts` — pure mapping rules. One module signal ↔ one PLC tag:
  `checkProcessMapping` (direction, program-driven tag only, `%Q`/`%M` for commands and
  `%M` for feedback, BOOL vs numeric, scaled range, unit) and `checkProcessMappings`
  (duplicates, register/bit overlap per PLC, required signals of the profile). Value
  conversion between the PLC bridge and the model.
- `lib/runtimes/process-bridge/runtime.ts` — `ProcessBridgeRuntime`: loads the models with
  the manual clock, and every cycle reads the PLC-driven tags (reusing `PlcBridge` and the
  Modbus codecs of the device simulator), sends changed inputs, steps each model by
  `cycleMs / tickMs` ticks and writes changed feedback. Per module: quality
  GOOD/STALE/DISCONNECTED, derived alarms from ALARM signals, the model's events once
  each, reload after the service forgot the instance. Shared instance per server process.
- `lib/services/process-bridge-service.ts` — `planProcessBridge` (stored modules and
  tags → models with settings, bindings, PLC endpoints; blocked modules with issues;
  skipped modules), `startProcessBridge`, `stopProcessBridge`, `getProcessBridgeState`.
  Mappings are given as `{ moduleId, signalKey, tagId }` (the registry is TASK-605).
  Module `status` follows the bridge. `stopFactory` stops the bridge first.
- `lib/db/repositories/process-bridge-repository.ts`; `getProcessBridgeDeps` in
  `lib/services/runtime-deps.ts`; env `PROCESS_SIM_TICK_MS` (100), `PROCESS_BRIDGE_CYCLE_MS` (200).
- Events: `PROCESS_BRIDGE_STARTED/STOPPED`, `PROCESS_STATE_CHANGED`,
  `PROCESS_QUALITY_CHANGED` (new family `PROCESS`), `PROCESS_ALARM_RAISED/CLEARED`
  raising/clearing alarms `PROCESS:<module>/<signal>`; `CONNECTION_UP/DOWN` with
  `link: process-bridge`.
- Module types: `PUMP_HOUSE` and `TANK` name their model in `simulatorModelType`;
  migration `20261006150000_process_model_link` sets it on the stored version 1 (the
  column was reserved for this; roles, signals and settings are unchanged).

Not in this task (by the phase plan): storing mappings, occupancy and allocation
(TASK-605), the module screen (TASK-604). A factory start does not start the bridge until
the registry supplies mappings.

## Evidence
- Unit: `lib/domain/process-bridge.test.ts` (10 tests, every rule),
  `lib/runtimes/process-bridge/runtime.test.ts` (8 tests: lockstep, in/out with scaling and
  types, change-only writes, events once, derived alarms, DISCONNECTED + recovery, STALE +
  reload, rollback of a refused load, two modules on one PLC), `lib/events/events.test.ts`
  and `lib/process-modules/process-modules.test.ts` updated.
- PostgreSQL: `test/integration/process-bridge.test.ts` (8 tests: plan, required
  signals, every refusal, duplicates, other owners, incomplete module, type without model,
  start blockers).
- OpenPLC + service: `test/integration/process-bridge-runtime.test.ts` (5 tests, ~19 s):
  the program on a real OpenPLC runtime commands the pump house, `PH_Pressure` is read at
  the PLC as a REAL in `%MD10` (2.94 bar at 70 %), the low-pressure alarm reaches `%MX10.1`
  and the alarm log and clears, the program's interlock trips at 3 bar and stops the pump,
  a gateway cannot write program- or process-driven tags, the module goes DISCONNECTED
  when the PLC stops, the bridge stops cleanly and unloads the models.

## Validation (2026-10-06)
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 81 files, 935 tests passed
  (214 s), including the OpenPLC loop above; no test container or network left behind.
- Dev database: migration `process_model_link` applied, `npm run db:seed` reports the two
  module types unchanged.
- Graphify refreshed: 3833 nodes, 10045 edges, 212 communities.
