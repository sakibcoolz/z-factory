# TASK-801 — Simulation Override Runtime Contract & Go API

Status: **DONE**
Linear: [ZFA-39](https://linear.app/recruit-verse/issue/ZFA-39)

## Goal
Create a controlled runtime API for overriding simulated sensor/process inputs without directly modifying PLC outputs.

## User stories
- As a tester, I can temporarily set a simulated temperature, pressure, level, flow or other supported process input.
- As a tester, I can clear an override and return the input to normal simulation.
- As an engineer, I can distinguish AUTO, MANUAL_OVERRIDE and SCENARIO state.

## Proposed contract
Example resource semantics:

```text
PUT    /simulations/{simulationId}/devices/{deviceId}/inputs/{inputId}/override
DELETE /simulations/{simulationId}/devices/{deviceId}/inputs/{inputId}/override
```

Example payload:

```json
{
  "mode": "MANUAL_OVERRIDE",
  "value": 46
}
```

The concrete API may evolve during implementation, but the semantics above are fixed.

## Runtime behavior
Each overrideable input keeps:
- input identity
- current mode
- calculated value
- effective value
- optional override value
- engineering unit
- timestamp
- source/operator metadata where available

Tick rule:

```text
MANUAL_OVERRIDE -> effective = override value
SCENARIO        -> effective = scenario value
AUTO            -> effective = model-calculated value
```

## Validation
- Reject values outside the simulation signal's allowed engineering range.
- Reject incompatible types/units.
- Reject override on outputs/actuator command endpoints.
- Reject unknown module/device/input identifiers.
- Clearing an absent override is idempotent.

## Acceptance criteria
- Go simulation service exposes tested override/clear operations.
- Override state survives normal ticks but not unintended permanent configuration changes.
- AUTO resumes correctly after clear.
- The process bridge consumes the effective value.
- No PLC local output is directly written by this API.

## Implementation (2026-10-06)
Design: docs/process-simulation.md → Overrides (Phase 08, TASK-801).

- `services/process-sim/internal/sim`: `Measured` and `Overridable` — each model declares the
  outputs that stand for measurements the PLC reads, with unit and range from its parameters
  (`PUMP_HOUSE`: discharge pressure, flow, valve open switch; `TANK`: level, high-level switch).
- `internal/engine/override.go`: modes `AUTO`, `MANUAL_OVERRIDE`, `SCENARIO` (RAMP or STEPS
  over simulated time); per instance the calculated outputs are kept and the delivered
  outputs carry the effective values; state per signal (mode, calculated, effective, value or
  profile, since tick and time, source); `OVERRIDE_SET` / `OVERRIDE_CLEARED` events; reset,
  reload and unload end overrides; clearing is idempotent.
- HTTP: `GET /v1/instances/{id}/overrides`, `PUT|DELETE /v1/instances/{id}/overrides/{signal}`.
  Contract note: the planned `/simulations/{id}/devices/{id}/inputs/{id}/override` resource is
  realised per module instance and signal; the semantics are those of this task.
- Z-Factory: client `overrides` / `setOverride` / `clearOverride`; types in
  `lib/domain/process-sim.ts`; `setProcessOverride`, `clearProcessOverride`,
  `listProcessOverrides` (only INPUT signals of a module running in the bridge, actor as
  source, `PROCESS_OVERRIDE_SET` / `PROCESS_OVERRIDE_CLEARED` events); the bridge snapshot
  carries the overrides and delivers effective values. No PLC output is written.

The screen is TASK-802; scenarios as recorded test runs are TASK-804.

## Evidence
- Go: `internal/engine/override_test.go` (3), `internal/api/server_test.go` (+1).
- `lib/runtimes/process-sim/client.test.ts` (+1), `lib/events/events.test.ts`.
- `test/integration/process-bridge-runtime.test.ts` (+1, real OpenPLC + service): pressure
  overridden to 3.5 bar while the pump runs at 2.94 bar → the PLC program trips and stops the
  pump; listing shows calculated 0 / effective 3.5; AUTO restores the calculated value; the
  trip stays latched until the program is reset; events recorded; a command and an
  out-of-range value refused.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 93 files, 1007 tests passed
  (250 s); no test container or network left behind.
- No schema change. No screen in this task.
- Graphify refreshed: 4385 nodes, 11698 edges, 236 communities.
