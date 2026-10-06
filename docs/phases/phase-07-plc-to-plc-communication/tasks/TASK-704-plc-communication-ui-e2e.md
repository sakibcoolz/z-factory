# TASK-704 — PLC-to-PLC UI, Validation & E2E Tests

Status: **DONE**
Linear: [ZFA-32](https://linear.app/recruit-verse/issue/ZFA-32)

## Goal
Expose PLC-to-PLC relationships and mappings in Z-Factory and prove the full communication path end to end.

## Scope
- PLC communication tab/section
- select source and target PLC
- select protocol and client/server role
- mapping table for local tag <-> remote register/tag
- READ/WRITE direction
- polling interval
- connection health
- stale/disconnected/error state
- validation summary
- topology edge between PLCs
- engineering export
- end-to-end scenarios

## Required E2E scenarios
1. PLC-A reads a status/feedback value from PLC-B.
2. PLC-A writes a permitted command/setpoint to PLC-B.
3. PLC-B local logic reacts to that command.
4. Invalid write to read-only feedback is rejected.
5. Target PLC disconnect produces stale/disconnected state.
6. Target PLC restart reconnects without rebuilding either image.
7. Cross-factory PLC relationship is rejected.

## Acceptance
- User can visually trace PLC-A tag -> communication mapping -> PLC-B register/tag.
- Connection and quality state are visible.
- Export includes source/target PLC, protocol, endpoint, mapping, direction and timing.
- E2E tests prove that two independent PLC programs remain isolated while exchanging configured data.

## Implementation (2026-10-06)
Design: docs/design.md → Communication as built (TASK-704).

- Route `/factories/[factoryId]/plcs/[plcId]/communication` (section "Communication" in the PLC
  shell), download `…/communication/[linkId]/link.json`; `routes.plcCommunication`,
  `routes.plcLinkFile`.
- `getPlcCommunicationView` (plc-communication-service) composes peers, links in either role,
  health from the link monitor, the deployed link version, mappings with quality and, for the
  client, picker options per direction with refusals (`linkEndRefusal` in the domain, plus
  "already filled/written by a link"). Shapes in `lib/domain/plc-communication-view.ts`.
- `components/plc/plc-communication.tsx` (server component: link cards, path line, deployment
  note, values table) and `plc-communication-forms.tsx` (client forms: new value with the two
  pickers, link settings, new link); server actions in `communication/actions.ts`.
- Topology: one `COMMUNICATES_WITH` edge per link from client to server with `plcLink`
  (relationship, values, enabled, href); label `supervises · Modbus TCP · n values`; the
  inspector shows the link and opens the Communication screen; the canvas never removes it.
- Engineering export: each link's values (direction, client tag, server tag and register,
  type, interval, state) in the document and in report section 11.

## Evidence
- E2E (`test/integration/plc-link-runtime.test.ts`, Docker, two real OpenPLC runtimes, 4
  tests, ~26 s): scenarios 1–3 (read status/counter, write a permitted command, the machine's
  program reacts), 4 (WRITE to the machine's feedback refused, `plc-link-remote-write`), 5
  (machine stopped → DISCONNECTED, last value kept), 6 (restart: same container and image,
  GOOD again, exchange resumes), 7 (link to another factory's PLC refused,
  `plc-link-factory`); the path is traceable in `getPlcCommunicationView` (role, deployed
  version, GOOD per value), as a topology edge and in the export with registers and intervals.
- `components/plc/plc-communication.test.tsx` (3), `lib/domain/plc-communication.test.ts`
  (+1 picker test), `components/export/plc-report.test.tsx` (link values), `app/screens.test.tsx`.
- Browser (headless Chromium against `next start`, temporary factory `ZZ Link Check`, removed
  afterwards): link created from the form; three values added through the pickers with their
  notices; the WRITE picker lists every other machine tag disabled with its reason
  (`program output: only a command or setpoint is written`, `already written by a link`); the
  machine's screen shows the link read-only as server; the topology edge reads
  `supervises · Modbus TCP · 3 values` and its inspector opens the Communication screen;
  `link.json` downloads with the three values.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds (routes `…/plcs/[plcId]/communication` and `…/[linkId]/link.json`).
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 93 files, 1005 tests passed
  (249 s); no test container or network left behind; the temporary factory was removed (only
  `milk` remains).
- No schema change.
- Graphify refreshed: 4330 nodes, 11546 edges, 239 communities.
