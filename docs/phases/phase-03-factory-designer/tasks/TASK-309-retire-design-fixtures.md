# TASK-309 — Retire Design Fixtures

Status: **DONE**
Linear: [ZFA-37](https://linear.app/recruit-verse/issue/ZFA-37)

Requested by the owner on 2026-10-06 ("remove dummy data from mocks"), after TASK-308.

## Objective
Remove the static design fixtures that TASK-104 placed behind the wireframe screens. Every screen reads the database now, so the fixture factories ("Pump House Demo", "Modular S7-1500 bench") and their dummy data are no longer needed.

## Scope
- Remove `lib/fixtures/` and everything that reads it: the "Design fixtures" section of the factory explorer, the `isDemoFactory` / `isModularBenchFactory` / `isDemoPlc` branches of the factory and PLC screens, `PlcSectionNav`, `CompactPlcConfig` and `ModularPlcConfig`.
- Unknown factory, PLC and device ids keep returning the not-found screen.
- The screen tests cover every route without fixtures, and check that nothing imports the fixtures.
- Documentation: `docs/design.md`, `docs/architecture.md`, `docs/status.md`, this file.

Out of scope: the demo factory builder (`createDemoFactory`, TASK-502), which creates real stored factories and stays.

## Prerequisites
TASK-308 merged.

## Acceptance
- No screen renders fixture data; `lib/fixtures/` is gone and nothing imports it.
- The factory explorer lists stored factories only.
- `/factories/factory_001` and the other fixture ids are not found.
- Lint, typecheck, build and the full test suite pass; the app is checked in a browser.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner, on 2026-10-06.

- **`lib/fixtures/` is gone and nothing imports it.** The fixture modules, their test, `PlcSectionNav`, `CompactPlcConfig` and `ModularPlcConfig` are deleted; the twelve pages that branched on `isDemoFactory` / `isDemoPlc` / `isModularBenchFactory` are plain wrappers of their stored screens; `loadFactory` no longer redirects a fixture id; the welcome screen no longer offers the fixture. A test walks `app/`, `components/` and `lib/` and finds no import of the fixtures and no `lib/fixtures` file.
- **The factory explorer lists stored factories only.** The "Design fixtures" section is removed. In the browser (production build) the sidebar shows Workspace with the stored factory and Host, nothing else.
- **Former fixture ids are not found.** `app/screens.test.tsx` renders every factory, PLC and device screen (21 routes) with `factory_001`, `factory_003`, `dev_001` and two unknown ids and expects the not-found screen for each. In the browser `/factories/factory_001/designer` shows "Nothing here yet"; the not-found text no longer mentions fixtures.
- **Nothing stored changed.** The demo factory builder ("Create pump station demo") and the stored screens are untouched; `docs/design.md` notes that the demo is a stored factory now.
- **Validation:** `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass; `TEST_DOCKER=1 npm test`: 891 tests in 74 files pass (894 before: the fixture tests went, the screens test covers 21 routes).

## Decisions made in this task
- **The screens test checks routes, not fixtures.** It is the one place that lists every page of a factory, a PLC and a device, and it proves each refuses an id that is no stored row before touching the database.
- **The 3D view's fixture scene went with the rest**; the stored scene (TASK-402) is the only one.
- **Stale notes in `docs/design.md` about the PLC configuration flow** (wiring from the Connections screen, add-and-wire in one action) were corrected to what TASK-307 built, since they sat next to the fixture notes.

