# TASK-604 — Process Module Designer & Validation

Status: **DONE**
Linear: [ZFA-27](https://linear.app/recruit-verse/issue/ZFA-27)

## Goal
Let users compose a process module from existing factory devices and allocate its PLC I/O safely.

## Scope
- module type/instance UI
- device-role assignment
- module logical I/O table
- compatible free PLC I/O/tag picker
- interlock/required-signal validation summary
- module topology visualization
- module configuration export/import contract
- tests for validation and UI states

## Invariants
- UI never invents hardware capabilities.
- Existing device and PLC compatibility/occupancy rules remain authoritative.
- Module assignment does not change device manufacturer/model identity.
- Process-specific options are driven by the selected ProcessModuleType.

## Acceptance
- User can create a module, assign existing devices, and bind all required signals.
- Occupied/incompatible endpoints are unavailable or rejected.
- Validation clearly distinguishes missing required signals from optional signals.
- Saved module configuration can be reconstructed without altering unrelated factory devices.

## Implementation (2026-10-06)
Design: docs/design.md → Process modules as built. Everything the screens offer comes from
the module service (TASK-601), the I/O registry (TASK-605) and the bridge (TASK-603); the
UI invents no capability and shows the services' refusals.

- Routes: `/factories/[factoryId]/modules` (list, new-module form) and
  `/factories/[factoryId]/modules/[moduleId]` (editor), the download
  `…/modules/[moduleId]/export/module-io.json`; a "Process modules" button on the factory
  overview. `routes.modules`, `routes.module`, `routes.moduleIoFile`.
- `lib/services/module-designer-service.ts` — `getModulesScreen` (modules with detail, the
  newest version of every type) and `getModuleDesigner` (detail, type, registry,
  candidates per signal, assignable devices per role by category, PLC nodes, live state
  from the bridge). `lib/domain/module-designer-view.ts` holds the shapes.
- `components/modules/`: `module-list.tsx` (readiness pill), `module-form.tsx` (type-driven
  profile and settings; `ConfigFieldInput`), `module-forms.tsx` (settings, role picker,
  signal picker with free tags first and refused ones disabled with the reason, interlock
  form with operators by data type, import), `module-editor.tsx` (the sections),
  `module-topology.tsx` (SVG from the registry and assignments), `delete-module.tsx`.
- Server actions in `app/factories/[factoryId]/modules/actions.ts` (create → redirect to
  the editor) and `…/[moduleId]/actions.ts` (update, delete, assign/unassign, bind/rebind/
  release, interlock add/enable/disable/remove, import, start/stop the process bridge).
  `lib/process-modules/form.ts` types the settings of a form by their declared kind.
- Service rule added: changing a module's profile is refused while a binding's signal has
  no place in the new profile (`module-profile-in-use`).

Not built: trends/scenarios (no data yet); a multi-condition interlock editor (one
condition per interlock in the form; the service accepts more).

## Evidence
- Browser (headless Chromium against `next start`, temporary factory `ZZ Module Check`,
  removed afterwards): list and new-module form render with the type's fields; assigning
  PT-01 to the transmitter role through its picker; binding four signals through the
  registry picker (status notices, "the module can run" after the last required one; the
  refreshed picker then lists the taken tags disabled with "Carries … of PH-01"); adding
  an interlock (`DISCHARGE_PRESSURE LT 1` blocks `DUTY_RUN_CMD`); the `module-io.json`
  download; releasing a signal and restoring it by importing the file ("4 bindings
  restored. The module can run."); creating a TANK module from the form with a redirect to
  its editor; a duplicate name refused under the form; deleting the module with the
  two-step button and the redirect to the list. Screenshots `mod-1…mod-11` in the session
  scratchpad.
- Unit: `components/modules/module-editor.test.tsx` (8), `lib/process-modules/form.test.ts`
  (1), `app/screens.test.tsx` extended with both routes; `test/integration/module-io.test.ts`
  extended with the profile/binding rule.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (routes `/factories/[factoryId]/modules`, `…/modules/[moduleId]`,
  `…/export/module-io.json`).
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 85 files, 962 tests passed
  (222 s); no test container or network left behind; the temporary browser-check factory
  was removed (only `milk` remains).
- Graphify refreshed: 3978 nodes, 10681 edges, 213 communities.
