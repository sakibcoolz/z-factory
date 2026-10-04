# TASK-104 — UI Shell & Wireframe Screens

Status: **IN PROGRESS**
Linear: [ZFA-7](https://linear.app/recruit-verse/issue/ZFA-7)

## Objective
Implement the Claude Design wireframes (turn 2, screens 2a–2q) as the presentational UI shell of the Next.js application: VS Code-style dark shell, Modernist design tokens, and one route per core screen in `docs/design.md`, rendered from static design fixtures.

## Source
- Claude Design project `2fc6a75c-7a5d-4a8c-a17c-17afa2d37f6c`, file `Z-Factory Wireframes.dc.html`, Modernist design system (`styles.css`, `readme.md`, `_adherence.oxlintrc.json`).
- Requested directly by the repository owner on 2026-10-04 as a design hand-off.

## Gate note
The owner requested this work while Phase 00 is still IN PROGRESS and TASK-101 was PLANNED. The request is treated as approval to start this task and the minimum of TASK-101 it depends on (a bootable Next.js app with lint/typecheck/test). No other Phase 01+ task is started by it.

## Scope
- Minimal Next.js App Router + strict TypeScript + Tailwind CSS bootstrap (see TASK-101).
- Design tokens: Modernist tokens plus the dark-shell palette, defined once in `app/globals.css`.
- Shell components: title bar, activity bar, side bar, editor tabs, panel, status bar.
- UI primitives used by the wireframes: state pill, button, input box, cell, key/value list, tree, table, log, pin, step, gauge, spark, device node.
- One route per wireframe screen (see `docs/design.md` → Wireframe reference).
- Static design fixtures under `lib/fixtures/`.
- ESLint rule enforcing the design system's "no raw hex / px literals in UI code" adherence check.

## Out of scope (owned by other tasks)
- Persistence, Prisma, factory CRUD (TASK-102, TASK-103).
- Docker, OpenPLC, Modbus, device simulation (Phase 02).
- Verified catalog data, compact/modular validation logic, React Flow editing, export generation (Phase 03).
- SSE live data and the React Three Fiber scene (Phase 04).

Buttons whose behavior belongs to those tasks are rendered but not wired. The designer and topology canvases are static stages, and the 3D view is the wireframe's SVG placeholder.

## Fixture rule
Everything under `lib/fixtures/` is transcribed from the wireframes. It is not live runtime state and not verified catalog data: vendor order numbers, I/O counts and electrical values shown on screen are design placeholders until TASK-301 supplies sourced, verified records (`docs/references/plc-source-policy.md`).

## Acceptance criteria
- Each of the 17 wireframe screens (2a–2q) has a route that renders its layout and content.
- All seven runtime states have a distinct visual treatment.
- Command/setpoint and actual feedback are shown separately on the simulator and live-tag screens.
- UI references Z-Factory IDs, never Docker IDs.
- No client-side code imports server-only modules (none exist yet; pages are server components).
- `npm run lint`, `npm run typecheck`, `npm test` and `npm run build` pass.
- `docs/design.md` records the screen → route map.

## Evidence (2026-10-04)
- `npm run lint` — clean, including the raw hex/px adherence rule on `app/` and `components/`.
- `npm run typecheck` — clean.
- `npm test` — 3 files, 40 tests passed: every screen 2a–2q renders in the shell with the right activity selected; unknown factory/PLC IDs and a compact/modular mismatch hit not-found; writes offered only on COMMAND/SETPOINT tags; command and feedback sections separate on the simulator; fixture invariants (unique instance names, unique addresses/tags, RW only on command/setpoint).
- `npm run build` — succeeds; 18 routes.
- Visual check: all 17 routes screenshotted from `next start` at 1280×760 in headless Chromium and compared with the wireframes.
- `npm audit --omit=dev` — 0 vulnerabilities. `npm audit` reports 5 high (braces → fast-glob → `@next/eslint-plugin-next`), lint tooling only.
- Graphify: `graphify update .` → 691 nodes, 1172 edges.

## Deviations from the wireframes
- The fake window traffic-light dots and the `UTC` clock in the status bar are omitted; the app is a browser page, not a window mock.
- Designer and topology canvases use one coordinate system for nodes and edges, so edges were re-routed to meet the nodes; the designer shows 6 links instead of the wireframe's 7 stray strokes.
- Counts in headers and status bars are derived from the fixtures (e.g. 8 live tags, GOOD 7 · STALE 1) instead of the wireframe's hand-written totals.
- PLC detail screens share the full 13-section navigation of `docs/design.md`; sections without a screen are listed but not linked.
- The export sheet is 680px wide (wireframe 520px) so the connected-device schedule fits without clipping.
- The 3D placeholder moves the MOTOR-01 label above its mesh to stop it overlapping PUMP-01.

## Remaining before DONE
- Owner review of the gate note and of the deviations above.
