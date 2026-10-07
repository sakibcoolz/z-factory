# TASK-907 — Recheck Command Expiry Immediately Before the PLC Write

Status: **DONE**
Linear: [ZFA-50](https://linear.app/recruit-verse/issue/ZFA-50)
GitHub: [issue 50](https://github.com/sakibcoolz/z-factory/issues/50) ([High], from a review of `develop` at `d2372fb`)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**. A follow-up of TASK-905 (the command lifecycle) and TASK-503 (the Thin Client Agent).

## Finding (confirmed on `d2372fb`)
The agent checks a cloud command's `expiresAt` only when the command arrives (`internal/command/command.go`, `Check`).
- The checked `command.Write` that goes into the PLC worker's queue carries no deadline.
- `Worker.execute` (`internal/worker/worker.go`) writes as soon as it holds the I/O lock, checking only the worker's state.

So a command that waits in the per-PLC queue (up to 16), or behind a slow poll holding the lock, can reach the PLC after its deadline.

## Objective
A command never reaches the PLC after its deadline: the absolute expiry travels with the command, and is checked again right before the write.

## Scope
- Carry the original absolute expiry through validation and queueing.
- After the connection lock is acquired, recheck the expiry immediately before any PLC write, and refuse an expired command with an explicit final outcome.
- Make expiry refusals observable (metrics, logs, the cloud acknowledgement).
- Document the deadline semantics and the clock-skew assumptions.

## Acceptance criteria
- A command that expires while queued, or while waiting for the connection lock, causes zero PLC writes.
- Tests cover expired on arrival, queue delay, lock delay, and a still-valid command.
- An expiry refusal is observable and gives a consistent cloud acknowledgement.

## Decisions
- **Expired on arrival:** REJECTED with rule `command-expired`, as before. Nothing was accepted.
- **Expired after acceptance** (in the queue or waiting for the lock): FAILED with the same rule `command-expired` and the reason "nothing was written". The command was accepted but not carried out. Web Factory already takes ACCEPTED → FAILED as a final answer.

## As built
- **`internal/command/command.go`:** `Write` carries `ExpiresAt`, the cloud's absolute deadline, unchanged from the envelope. `Check` sets it. `RuleExpired = "command-expired"`.
- **`internal/worker/worker.go`, `execute`:**
  - checks the deadline when it takes the command from the queue;
  - checks it again once it holds the PLC connection (`w.io`), immediately before `WriteCoil` or `WriteRegisters`;
  - answers an expired command `FAILED`/`command-expired` ("nothing was written") without writing;
  - treats a command without a deadline (never checked) as expired.
- **`internal/uplink/uplink.go`:** expired commands are counted (`commands.expired` in `/v1/status`, `zfactory_agent_commands_total{outcome="expired"}`) and logged with the command id. The FAILED ack carries the rule and reason.
- **`internal/modbustest`:** `Received()` counts requests on arrival, so a test can act while a poll is in flight.
- **Web Factory:** unchanged. ACCEPTED → FAILED is final; the rule and reason are kept and audited (`COMMAND_FAILED`).
- **Docs:** the deadline semantics and clock assumptions in `docs/thin-client-agent.md` → Commands; ADR-0022 amended; `docs/edge-deployment.md` (metric, troubleshooting, an NTP step in the physical checklist).

## Acceptance criteria — evidence
- **A command that expires while queued or waiting for the connection lock makes zero PLC writes:**
  - `TestNeverWritesACommandThatExpiredInTheQueue`: a command with a 150 ms deadline, queued behind a slow (300 ms per request) valid write, fails `command-expired`; the PLC saw only the valid write;
  - `TestNeverWritesACommandThatExpiredWaitingForTheConnection`: a command submitted while a poll holds the connection passes the first check, waits, and fails `command-expired` after taking the lock; the PLC saw no write;
  - the uplink test over MQTT: a command accepted in time, then expired behind a slow write, is answered `ACCEPTED,FAILED:command-expired`, and PLC A's coil was never written.
- **Tests cover expiry on arrival, queue delay, lock delay and a still-valid command:**
  - on arrival: `REJECTED:command-expired` in the command and uplink tests;
  - queue and lock delay: the two tests above;
  - still valid: `TestWritesACommandStillWithinItsDeadline` (APPLIED, one write, read back);
  - plus `TestNeverWritesACommandWithoutADeadline`.
- **Expiry refusal is observable, with a consistent cloud acknowledgement:**
  - the same rule, `command-expired`, either way: REJECTED on arrival, FAILED once accepted;
  - the `expired` counter (the uplink test checks `expired == 1`);
  - Web Factory records FAILED with the rule and reason, audited once (`test/commands.test.ts`).

## Evidence
- **Mutation checks:**
  - without the fix, the queue-delay, lock-delay and no-deadline tests fail, and the uplink test sees `ACCEPTED, APPLIED`;
  - with only the check before the lock, the lock-delay test fails;
  - with the fix, all pass.
- **Stability:** the timing tests passed 15 times in a row with `-race`.
- **Go:** `gofmt`, `go vet` and `go test -race ./...` (with Docker) pass; `packaging/test-packaging.sh` passes.
- **`apps/web-factory`:** 15 files and 86 tests pass with Docker and the rebuilt agent, including the end-to-end command tests. Lint, typecheck and build are clean.
- **Root project:** prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` (with the rebuilt agent) passes: 97 files, 1034 tests.

## Remaining limitations
- **Clock synchronization:** the deadline is compared with the edge host's clock, so the edge host and the cloud need synchronized clocks (NTP).
  - A slow agent clock can let a command be written after the cloud's deadline, by at most the clock error.
  - A fast one refuses commands early, which is safe.
  - Recorded in the docs and in the physical checklist.
- **The window after the last check:** it is one Modbus write call. A command that passed the last check is written even if its deadline passes during that call.

