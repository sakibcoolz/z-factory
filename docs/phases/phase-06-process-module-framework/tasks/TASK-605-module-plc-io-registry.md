# TASK-605 — Module PLC I/O Registry & Allocation

Status: **DONE**
Linear: [ZFA-28](https://linear.app/recruit-verse/issue/ZFA-28)

## User story
As a Z-Factory engineer, I want every process-module instance to explicitly register the PLC inputs and outputs it consumes so that a boiler, tank, conveyor cell or future module can be connected to a PLC without hard-coding a universal I/O count or changing unrelated device/runtime code.

## Goal
Create one authoritative module-level registry that answers:
- which logical PLC inputs the module consumes
- which logical PLC outputs the module consumes
- which signals are required vs optional
- which concrete PLC/tag/I/O/Modbus endpoint each signal is bound to
- whether each binding is valid, occupied, stale or missing

## Scope
- ModuleSignalDefinition as the reusable logical contract
- ModulePlcIoMapping as the factory-specific binding
- module I/O registry service/query
- required/optional signal validation
- PLC ownership and same-factory checks
- channel/tag compatibility validation
- I/O occupancy and Modbus register-overlap validation
- bind, rebind and release operations
- consumed-I/O summary per module and per PLC
- export/import representation
- tests and API/UI documentation

## Direction convention
Directions are from the PLC program perspective.

- INPUT: PLC reads process/device feedback.
- OUTPUT: PLC writes command/setpoint.
- INTERNAL: simulator/runtime value not directly mapped to PLC I/O.
- ALARM: alarm/status signal exposed according to the selected profile.

## Example
```text
BOILER-01
  INPUT  TT_BOTTOM       -> PLC-01 / tag TT_BOTTOM       / Input Register
  INPUT  TT_MIDDLE       -> PLC-01 / tag TT_MIDDLE       / Input Register
  INPUT  TT_TOP          -> PLC-01 / tag TT_TOP          / Input Register
  INPUT  LEVEL           -> PLC-01 / tag LT_101          / Input Register
  OUTPUT HEATER_ENABLE   -> PLC-01 / tag HEATER_ENABLE   / Coil
  OUTPUT HEATER_POWER    -> PLC-01 / tag HEATER_POWER    / Holding Register
  OUTPUT PUMP_CMD        -> PLC-01 / tag PUMP_CMD        / Coil
```

The exact count is profile/configuration driven. The framework must not claim that every boiler consumes the same number of PLC points.

## Invariants
- The registry reuses normal Z-Factory Tag, PlcIoPoint and protocol-address rules.
- A module cannot create a parallel PLC address space.
- A module cannot bind a device, PLC or tag from another factory.
- One physical PLC endpoint cannot be allocated twice unless the underlying endpoint semantics explicitly permit sharing.
- Data type, direction, access mode, signal type, engineering unit/scaling and multi-word register span must be validated.
- Releasing a module mapping must not delete the underlying reusable device or PLC unless a separate delete operation requests it.
- PLC remains the control authority.

## Acceptance
- User can inspect the complete consumed input/output list for a module instance.
- Required unmapped signals block module runtime start with a clear validation result.
- Optional signals may remain unbound without blocking runtime.
- Compatible free PLC endpoints can be bound and incompatible/occupied endpoints are rejected.
- Rebinding/releasing updates occupancy correctly.
- An export reconstructs logical signal -> PLC tag/I/O/register bindings.
- Tests cover duplicate allocation, cross-factory binding, wrong direction/type, register overlap and required-signal validation.

## Implementation (2026-10-06)
Design: docs/process-modules.md → The PLC I/O registry; docs/database.md → ModulePlcIoMapping;
docs/api-contract.md → `process-modules/io-registry`.

- `prisma/migrations/20261006160000_module_plc_io_mapping` — `ModulePlcIoMapping`
  (module, signal definition, PLC, tag; unique tag; unique module+signal; cascade with
  module, tag and PLC; restrict on the signal definition). No parallel address space: the
  tag is the endpoint; its I/O point is read through the tag.
- `lib/domain/module-io-view.ts` — registry shapes and `buildModuleIo`: rows per consumed
  signal of the profile (BOUND / INVALID / UNBOUND, `blocking`, issue, binding view),
  internal signals apart, counts per direction, per-PLC use. Every stored binding is
  re-checked with the bridge rules (`lib/domain/process-bridge.ts`) on every read.
- `lib/services/module-io-service.ts` — `getModuleIoRegistry`, `listBindableTags`
  (candidates with refusals and holders), `bindModuleSignal`, `rebindModuleSignal`,
  `releaseModuleSignal` (module row locked; tag uniqueness is a constraint),
  `getFactoryIoSummary`, `listFactoryModuleMappings`, `exportModuleIo` / `importModuleIo`
  (`z-factory.module-io` v1, by PLC and tag names, same type version and profile, all or
  nothing).
- Module summaries carry `bindings` counts and `readyToRun`. `planProcessBridge` reads the
  stored bindings when no mappings are given; `startFactory` starts the bridge after the
  device simulation when the factory has modules to run (`processModules`, `processNote`);
  `stopFactory` stops it. The runtime screen's start notice reports it.
- PLC engineering export: `moduleSignals` in the document and a table under section 7 of
  the report (the module signals the PLC's tags carry).
- Constraint messages in `lib/db/errors.ts`; schemas in `lib/validation/process-module.ts`.

Not in this task: the screen and picker (TASK-604) — the services return everything a
picker needs (`listBindableTags` with refusals).

## Evidence
- Unit: `lib/domain/module-io-view.test.ts` (3), `components/export/plc-report.test.tsx`
  (module signals table).
- PostgreSQL: `test/integration/module-io.test.ts` (12 tests: unbound list and blocking,
  candidates with refusals, bind/ready, every refusal incl. other owner and another module,
  race for one tag → exactly one wins, rebind/release, INVALID when the tag changes and
  gone with the tag, profile change, factory summary and bridge plan from stored bindings,
  PLC export, export/import, cascade on delete). `process-modules`, `process-bridge` tests
  still green.
- OpenPLC + service: `test/integration/process-bridge-runtime.test.ts` now binds through
  the registry and adds `startFactory`/`stopFactory` running the bridge from the stored
  bindings (6 tests).

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 83 files, 951 tests passed
  (220 s); no test container or network left behind.
- Dev database: migration `module_plc_io_mapping` applied.
- Graphify refreshed: 3883 nodes, 10274 edges, 209 communities.
