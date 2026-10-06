# TASK-602 — Go Simulation Service Foundation

Status: **DONE**
Linear: [ZFA-25](https://linear.app/recruit-verse/issue/ZFA-25)

## Goal
Implement the ADR-0008 Go service as an additive advanced-process runtime.

## Scope
- standalone Go service/container
- deterministic configurable simulation clock/tick
- per-factory/per-module in-memory state
- common simulator/model interface
- lifecycle: load, start, pause/stop, reset, inspect, health
- versioned configuration contract from Z-Factory
- resource limits and isolation policy
- structured logs, health and basic metrics
- unit/integration test harness

## Invariants
- Do not replace the Phase 02 shared device simulator.
- PLC remains the control authority.
- Do not persist every tick to PostgreSQL.
- One process model may host many module/device states; do not create one container per simple sensor/valve/motor.
- Determinism must be testable with fixed configuration, inputs and time steps.

## Acceptance
- Service runs a deterministic tick loop for multiple independent module instances.
- It can load versioned module/model configuration and report health/state.
- Restart/reset behavior is defined and tested.
- No direct browser-to-simulation privileged control path exists.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner, on 2026-10-06. Contract and behaviour: `docs/process-simulation.md`.

- **A deterministic tick loop for multiple independent module instances.** `services/process-sim` (Go 1.26, standard library only) hosts up to `PROCESS_SIM_MAX_INSTANCES` instances in one process; each is a model advanced by a fixed step `tickMs / 1000` s, on a wall clock of its own or by manual steps. Models use no clock and no randomness. Tested in Go: the same configuration stepped the same way gives byte-equal outputs, state and events; two instances step independently and a manual one never moves on its own; a wall-clock one ticks until stopped. Tested from Z-Factory against the running binary: two pump houses and a tank, stepped separately, give equal results for equal steps and leave each other alone.
- **Versioned configuration, health and state.** Contract version 1 (`contractVersion`, model type and version, `configVersion`, tick, clock, parameters, initial inputs) is validated against a closed schema and the model; nine wrong configurations are refused with the reason (tested). `GET /healthz` reports status, version, contract version, uptime, instances and model types; `GET /v1/instances/{id}` the full snapshot (status, tick, simulated time, inputs, outputs, state, last event); `GET /metrics` instances by status, ticks and last tick duration.
- **Restart and reset are defined and tested.** Reset returns an instance to tick 0 with its configured inputs and no outputs, keeps its events and records `RESET`; the next run reproduces the first (tested in Go and over HTTP). Stop keeps the state and start continues it (tested). A restart of the service starts empty — instances live in memory, Z-Factory owns the configuration and reloads it — proven by killing and restarting the binary in the harness.
- **No browser path.** Every request but the health check needs a bearer token of at least 16 characters, without which the service does not start (tested). Only `lib/runtimes/process-sim/client.ts` (server-only) sends it; a test walks `app/`, `components/` and `lib/` and finds no other importer of the client and no mention of the token under `app/` or `components/`. The compose service binds to `127.0.0.1`.
- **Invariants.** The Phase 02 device simulator is untouched. Models compute responses to inputs the PLC drives and decide no command. Nothing is written to PostgreSQL by the service or for it; no schema change in this task. Two models host every instance of their type in the one process. Determinism is tested with fixed configuration, inputs and steps.
- **Resource limits and isolation.** Multi-stage Dockerfile to a distroless static image, non-root; `compose.yaml` (`--profile sim`) adds read-only filesystem, `cap_drop: ALL`, `no-new-privileges`, 1 CPU, 256 MB, 128 processes, localhost port. The image was built and run here: health answered, `/metrics` without a token answered 401; container and image removed afterwards.
- **Logs and metrics.** JSON logs (`log/slog`) for requests, lifecycle changes and events; metrics as above.
- **Tests:** 11 Go test functions (`go test -race ./...`: model contract, repeatability, pump-house and tank dynamics, parameter refusals, engine lifecycle and limits, wall clock, HTTP authentication and lifecycle), 4 client tests and 4 harness tests from Z-Factory (`PROCESS_SIM_BIN`); the Z-Factory suite went from 896 to 904. CI runs `gofmt`, `go vet`, `go test -race`, builds the binary and passes it to `npm test`. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass; `TEST_DOCKER=1 npm test` with the harness: 904 tests in 77 files pass.

## Decisions made in this task
- **Go 1.26 with the standard library only**: `net/http` routing, `log/slog`, `encoding/json`; no framework and no `go.sum`. Installed under `~/.local/go` on the development machine; CI uses `actions/setup-go`.
- **The API is HTTP/JSON, not gRPC**: one client in the server, a small surface, readable in logs and tests. A different transport would be a new contract version.
- **Two clocks.** `wall` for a running factory, `manual` for tests and for a bridge that wants to step in lockstep with its polling. Simulated time is the tick count; a missed wall tick is not caught up.
- **Two models ship**, named for the shipped module types (`PUMP_HOUSE`, `TANK`) and speaking their signal keys, so TASK-605 can bind them. The module types still carry `simulatorModelType: null`; naming a model on a type is a new type version and belongs with the bridge (TASK-603).
- **A low-pressure alarm needs a setpoint of at least half speed**: a pump asked for a low speed is not in alarm for being slow.
- **Inputs absent from the configuration are zero**, except the pump's setpoint (100 %) and discharge valve (open), so a pump house without those signals still runs.
- **Replacing an instance (load with the same id) stops the old one and starts the new one from its initial state**; a running configuration change is a reload, not a hot patch.
- **Not done:** no PLC binding, no quality or stale semantics (TASK-603); no persistence of snapshots or events by the service (Z-Factory records what it reads, later); no Prometheus text format (JSON metrics); no TLS between server and service (both on one host, localhost-bound; a remote service would need it).

