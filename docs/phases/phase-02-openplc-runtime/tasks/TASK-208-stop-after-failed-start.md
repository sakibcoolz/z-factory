# TASK-208 — "Stop Factory" Must Leave a Factory Stopped After a Failed Start

Status: **DONE**
Linear: [ZFA-53](https://linear.app/recruit-verse/issue/ZFA-53)

## Finding (2026-10-07)
After a start that failed before any container existed, the factory stayed DEGRADED with its PLC FAULTED.
- "Stop factory" answered that the simulation and every PLC runtime were stopped, but the stored states did not change.
- Editing and deleting, which need a stopped factory, were refused.
- Only "Refresh state" on the PLC's own Runtime screen reconciled it.

## Acceptance criteria
- "Stop factory" reconciles every PLC with its real container state (absent, exited or running), so a factory with nothing running ends STOPPED.
- What it reports matches the stored state afterwards.
- A factory whose start failed can then be edited and deleted without a per-PLC workaround.
- Tests cover a failed start (no container) followed by stop, edit and delete.

## Cause
`stopFactory` stopped only PLCs that had a container id and were not stored as STOPPED. A PLC whose start failed before its container was created was reported STOPPED but never stored as such. The factory's summary state was only recomputed when a PLC's state was written, so it stayed DEGRADED.

## Implementation
- `lib/services/plc-runtime-service.ts`: `settlePlcStopped(deps, actor, plcId)` inspects the PLC's container.
  - If the container runs, it is stopped the way `stopPlc` stops it, through the shared `stopContainer`.
  - If it exited, is missing (NOT_FOUND), or never existed, the PLC is stored STOPPED, with a `DEVICE_STOPPED` event carrying `{ reconciled: true, from: <previous state> }`. An already stopped PLC is left as it is.
  - If Docker cannot be asked about an existing container, the error is reported and nothing is changed.
- `recordFactoryRuntimeState(db, factoryId)` stores the summary of the PLCs' states. `setDeviceState` uses it as well.
- `lib/services/factory-runtime-service.ts`: `stopFactory` settles every PLC, reports the state each one was stored with, and then stores the factory's summary.
- Docs: `docs/architecture.md` (the factory runtime).

## Evidence (2026-10-07)
- **`test/integration/factory-stop.test.ts`** (new). All four tests fail on the previous code and pass now.
  - **No Docker engine:**
    - a start fails before any container, leaving the factory DEGRADED and the PLC FAULTED, and edit is refused;
    - "Stop factory" then reports and stores STOPPED for both, records a `DEVICE_STOPPED` event with `reconciled`, and the subnet edit and the delete succeed.
  - **Stale summary:** a DEGRADED factory summary with every PLC already stopped is stored as STOPPED, with no extra events.
  - **Real Docker, the case seen in the browser:**
    - a network outside Z-Factory holds the factory's subnet, so the start fails with `docker-subnet-overlap`;
    - stop then gives STOPPED, the edit works, and the delete removes nothing because nothing was created.
  - **Real Docker, mixed states:**
    - a running container stored DEGRADED is really stopped, and an exited one stored FAULTED is settled, so the factory is STOPPED;
    - a container removed outside Z-Factory is settled too.
- **Browser** (production build, headless Chromium, dev database). I created a pump station demo factory on 172.20.1.0/24, then created a stray network on that subnet so the start would fail before any container.
  - "Start factory" showed "This subnet overlaps a network that already exists on the Docker host." The factory was DEGRADED and PLC-01 FAULTED.
  - "Stop factory" with Confirm showed "The simulation and every PLC runtime are stopped…" and the screen showed STOPPED everywhere. Before the fix, the states stayed DEGRADED and FAULTED.
  - The subnet edit to 172.20.9.0/24 was saved, and the factory page showed STOPPED.
  - Delete → Confirm delete went back to /factories.
  - The stray network, the preview and the browser were removed afterwards. The host had 0 managed containers and networks, and the dev database had 0 factories.
- **Gates:**
  - `npx prettier --check .`, `npm run lint`, `npx tsc --noEmit` and `npm run build` are clean;
  - `TEST_DOCKER=1 npm test` with `.env`, `PROCESS_SIM_BIN` and `AGENT_BIN`: 98 files, 1048 tests passed.

## Limitations
- The PLC's own Runtime screen still offers "Refresh state" for a single PLC; this task changes only "Stop factory".
- If Docker cannot be reached while a PLC still has a container, stop fails with that error instead of guessing.
