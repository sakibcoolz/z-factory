# TASK-201 — Docker Engine Integration

Status: **DONE**
Linear: [ZFA-8](https://linear.app/recruit-verse/issue/ZFA-8)

## Objective
Implement server-only Docker Engine integration and safe factory network/container lifecycle.

## Acceptance criteria
- Docker code cannot be imported by client components.
- Image allow-list.
- Safe network/subnet creation.
- Port conflict validation.
- CPU/memory limits.
- No arbitrary host volume/privileged/command injection.
- Lifecycle integration tests.

## Evidence (2026-10-05)
- Client boundary: every `lib/docker/*` module starts with `import "server-only"` (asserted by a test); ESLint blocks `components/**` from importing it; a client component importing `lib/docker/client` makes `next build` fail (verified, then removed).
- Image allow-list: `RUNTIME_IMAGES`, selected by key only; raw references and unknown keys are rejected; pinned digests are verified after pull. The list ships empty.
- Safe network/subnet creation: `ensureFactoryNetwork` — validated name and subnet, labelled bridge network, idempotent, refuses overlap with any existing Docker network and refuses a reused name.
- Port conflict validation: `assertPortBindings` + `listPublishedPorts` — allowed bind addresses, allowed range, no duplicates, no collision with ports claimed on the host.
- CPU/memory limits: defaults and maxima in `DEFAULT_LIMITS`; applied as `NanoCpus`, `Memory`, `MemorySwap`, `PidsLimit`.
- No arbitrary host volume/privileged/command injection: strict request schema; 13 escape attempts are tested and rejected; hardened settings are fixed in `buildContainerSpec`.
- Lifecycle integration tests against a real Docker Engine (29.7.2 locally): network create/confirm/overlap/name reuse, container create with limits and hardening, host-port conflict, start/restart/stop, network kept while in use, remove, and refusal to touch unmanaged containers and networks. 8 tests, gated by `TEST_DOCKER=1`; the host had the same containers and networks before and after.
- Totals: 202 tests pass with `TEST_DATABASE_URL` and `TEST_DOCKER=1` (43 Docker unit tests, 8 Docker lifecycle tests, 3 status tests added). Format check, lint, typecheck and build pass. CI runs the Docker lifecycle tests too (`TEST_DOCKER=1` in `.github/workflows/ci.yml`).
- The factory screens show the real engine status (reachable + version, or unreachable).

## Not in this task
- No screen starts or stops a factory; `Factory.runtimeStatus` and `DeviceInstance.dockerContainerId` are written by the runtime adapters (TASK-202).
- Persisted `RuntimePort` allocation and Modbus host-port mapping (TASK-203).
- Production hardening behind a constrained Docker API proxy is supported by `DOCKER_HOST=tcp://…` but not set up.
