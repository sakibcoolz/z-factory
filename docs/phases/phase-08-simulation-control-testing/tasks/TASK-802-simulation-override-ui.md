# TASK-802 — Simulation Override UI & Operator Controls

Status: **DONE**
Linear: [ZFA-40](https://linear.app/recruit-verse/issue/ZFA-40)

## Goal
Expose safe test controls in Z-Factory UI for simulation inputs.

## UX
For overrideable sensor/process inputs show:
- current effective value
- engineering unit
- source: AUTO / MANUAL_OVERRIDE / SCENARIO
- Set Override action
- Clear Override action
- validation message
- last change timestamp

Example:
`TT-101 Temperature | AUTO 38.2 °C | Override…`

Test:
`TT-101 Temperature | MANUAL_OVERRIDE 46.0 °C | Clear`

## Rules
- Browser calls Z-Factory server actions/routes; it does not call the Go service directly.
- Controls appear only for simulation inputs declared overrideable.
- PLC outputs are read-only in this testing UI.
- UI clearly warns that changing a simulated input may cause PLC logic to actuate outputs.
- Clearing returns to AUTO; no hidden stale override remains.

## Acceptance criteria
- User can set 46 °C from UI and see the simulator report MANUAL_OVERRIDE.
- Invalid ranges/types are rejected with a useful message.
- Clear returns the input to AUTO.
- Live UI shows the effective value and resulting PLC/device state.

## Implementation (2026-10-06)
Design: docs/design.md → Test inputs as built (TASK-802).

- Placement: the process module editor's Runtime section, while the module runs in the bridge
  — where the module's live values already are. Rows for the module's INPUT signals the model
  declares measured; PLC outputs and commands have no control.
- `getModuleDesigner` adds `runtime.testInputs` (mode, calculated, effective, value or profile,
  since, source, range, the PLC tag) from `listProcessOverrides`; `TestInputView` in
  `lib/domain/module-designer-view.ts`.
- `TestInputRow` (`components/modules/module-forms.tsx`): manual value / on-off / ramp, Override,
  Clear (only when overridden), the server's message under the row; warning above the table.
- `overrideAction` server action → `setProcessOverride` / `clearProcessOverride` (TASK-801).
- The client strips the service's `invalid configuration:` prefix so refusals read as reasons.

## Evidence
- `components/modules/module-editor.test.tsx` (+2).
- Browser, end to end (headless Chromium against `next start` with the built simulation
  service; temporary factory `ZZ Override Check` with a real OpenPLC container, started from the
  runtime screen — "1 PLC running, 2 simulated devices running, 1 process module running"; all
  removed afterwards): pump running at 2.94 bar; 99 bar refused with "DISCHARGE_PRESSURE takes 0
  to 12 bar"; 3.5 bar set from the screen → `MANUAL_OVERRIDE`, "since 41.8 s · by local-owner",
  PLC read 3.5 bar, its program tripped (`High_Pressure_Trip` true, run command off) and the model
  showed 0 bar beside the delivered 3.5; Clear → `AUTO`, 0 bar from the model; after the program's
  reset the pump ran again at 2.94 bar.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 93 files, 1009 tests passed
  (252 s); no test container or network left behind; the temporary factory, its container and
  network were removed (only `milk` remains).
- No schema change.
- Graphify refreshed: 4395 nodes, 11729 edges, 227 communities.
