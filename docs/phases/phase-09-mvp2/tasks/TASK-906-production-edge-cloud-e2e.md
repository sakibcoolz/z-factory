# TASK-906 — Production Edge Deployment, Resilience, Security & Physical E2E

Status: **DONE** (stand-in scope; the run on physical hardware is open)
Linear: [ZFA-49](https://linear.app/recruit-verse/issue/ZFA-49)

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Prove MVP 2 on a real/industrial edge host with multiple dynamic PLC configurations, cloud MQTT, Web Factory, offline recovery and measurable bounded-resource behavior.

## Scope
- Deploy Go Thin Client Agent via systemd and/or container on Raspberry Pi/industrial Linux gateway.
- Validate exported JSON staging/active/rejected lifecycle and hot reload.
- Run configurable N PLC workers; no fixed 150 assumption.
- Measure CPU, memory, goroutines, queue depth, spool size and network behavior.
- Validate one PLC failure/slow response does not impact others.
- Validate cloud/MQTT outage: PLC polling continues, telemetry spools locally, controlled replay after reconnect.
- Validate agent restart and last-known-good configuration recovery.
- Validate TLS/mTLS/credential rotation approach and no plaintext production secrets in exported JSON.
- End-to-end: PLC -> Thin Client -> MQTT -> Web Factory telemetry and Web Factory -> MQTT -> Thin Client -> allowed command/setpoint -> PLC logic -> feedback.
- Failure injection for broker outage, PLC outage, malformed config, duplicate command and disk/spool pressure.

## Acceptance criteria
- Physical edge deployment is repeatable.
- Dynamic multi-PLC workers remain isolated and bounded under load.
- Offline store-and-forward survives restart and reconnect.
- Web Factory receives telemetry and command acknowledgements end to end.
- Security/observability evidence is captured.
- All failure/recovery E2E scenarios pass without bypassing PLC control authority.

## Decisions (owner, 2026-10-07)
- **No edge hardware yet.** Build a production-like stand-in on the development machine and a repeatable deployment kit. The run on physical hardware stays open, as a checklist.
- **Transport:** MQTT over TLS (8883) with a CA file, keeping per-agent passwords; no mTLS.

Recorded in ADR-0023.

## As built
Runbook: `docs/edge-deployment.md`.
- **Kit** (`services/zfactory-thin-client-agent/packaging/`):
  - `build.sh`: static, reproducible linux amd64, arm64 and armv7 binaries with `SHA256SUMS`;
  - `install.sh`: install, upgrade (atomic, keeps `.previous`, settings, state and spool) and uninstall or purge, refusing a binary whose checksum does not match;
  - `zfactory-agent.service`: systemd hardening, `StateDirectory`, `MemoryMax` and `TasksMax`;
  - `agent.env.example`: settings, with secrets kept in files;
  - `Dockerfile`: distroless, non-root, about 4 MB, health check with `-probe`;
  - `test-packaging.sh`: the kit's own test, in CI.
- **Agent:**
  - `/metrics` gains goroutines, heap, OS memory, GC, CPU time, peak RSS, per-PLC poll duration and failures, MQTT connects, losses and publishes, spool written and replayed, and commands by outcome;
  - `-probe` for health checks;
  - each poll's duration in `/v1/status`.
- **Broker:** `broker/mosquitto-tls.conf` (TLS only on 8883) and `broker/dev-ca.sh` (a throwaway CA for tests).
- **Stand-in run:** `scripts/edge-standin.sh` drives:
  - `test/edge-standin/plc-lab.ts`: real OpenPLC runtimes through Z-Factory, with an IEC program holding an interlock (`Running := Start_Cmd AND Speed_SP > 0`);
  - `apps/web-factory/test/edge-standin.test.ts`: the release image, hardened, over TLS against Web Factory, N simulated PLCs and those runtimes.

  It writes a measured report and removes everything it started.

## Acceptance criteria — evidence
Final stand-in run: `scripts/edge-standin.sh` with 200 simulated PLCs and 2 real OpenPLC runtimes; 9 of 9 checks passed. PLCs are polled every 500 ms (the OpenPLC ones every 250 ms). The agent is the release image `zfactory-agent:standin-<sha>`, run with `--read-only --cap-drop ALL --security-opt no-new-privileges`, not root, `--memory 256m --pids-limit 512`, on a TLS-only broker.

- **Repeatable deployment (as far as possible without hardware):**
  - two builds give identical checksums;
  - `test-packaging.sh` passes: a tampered binary is refused; layout and modes are right; an upgrade keeps settings, state and spool, and the previous binary; uninstall keeps state; purge removes it; `systemd-analyze` accepts the unit;
  - the image runs *healthy*, read-only and non-root.
  - **Open:** a physical install, real LAN timing and ARM execution (the checklist).
- **Dynamic multi-PLC workers stay isolated and bounded under load:**
  - 202 PLCs deployed to the running agent were all online in Web Factory within 0.7 s;
  - with one PLC slower than its timeout and one gone, the other 195 PLCs stored 3754 batches in 10 s, against 3738 before (ratio 1.00); both raised a PLC connection alarm in Web Factory;
  - at 202 PLCs the agent ran 428 goroutines with an 8.9 MB heap, used 36.6 MiB in its container (1.7 % CPU, 26 processes), and dropped nothing from its queue; the slowest poll took 8 ms;
  - a broken file and a tampered file went to `rejected/` while the PLCs kept running;
  - a hot update ran version 2 of one PLC without disturbing the others.
- **Offline store-and-forward survives restart and reconnect:**
  - the broker was stopped for 26 s, and the agent restarted inside the outage (0.9 s);
  - 10,282 batches were spooled on disk and 10,713 replayed;
  - for one PLC, 52 batches were stored for the outage window, against about 47 expected, with exactly one sample per batch: nothing lost, nothing duplicated;
  - Web Factory stored 54,447 batches with 0 duplicates and 0 errors;
  - under pressure (spool limit 256 KiB), the spool held at 262,015 bytes and dropped the oldest 42 batches, counted.
- **Web Factory receives telemetry and command acknowledgements end to end:**
  - telemetry from every PLC is in Web Factory;
  - commands went over TLS to the agent and back (the agent counted 11 received, 10 applied, 1 duplicate), with acknowledgements in Web Factory.
- **Security and observability evidence:**
  - a broker certificate that is not trusted is refused ("unable to verify the first certificate");
  - no password, secret or token is in any deployment file, and the agent's password is not in the container's environment;
  - the container runs read-only, with every capability dropped, not as root;
  - all the metrics above come from the agent's `/metrics`.
- **Every failure and recovery scenario passes without bypassing PLC control authority:**
  - on the simulated PLC with an interlock and on both real OpenPLC programs, *Start* was written and applied, but the machine did not run while the speed setpoint was 0;
  - with Speed_SP at 25 the program ran it (Speed_Ref 25), and *Stop* stopped it;
  - a redelivered command was answered as a duplicate and not written again (2 writes for 2 commands).

## Evidence
- Go: `gofmt`, `go vet` and `go test -race ./...` pass, including the MQTT tests on Docker and the new metric assertions.
- Kit: `packaging/test-packaging.sh` passes, and the hardened container runs *healthy*.
- `apps/web-factory`: 15 files and 86 tests pass. The 9 stand-in tests run through `scripts/edge-standin.sh`; they passed at N=20, N=10 plus 1 OpenPLC, and N=200 plus 2 OpenPLC. Lint, typecheck and build are clean.
- Root project: prettier, lint, typecheck and build are clean, and `TEST_DOCKER=1 npm test` passes: 97 files, 1034 tests.
- The stand-in removes everything it starts: containers, networks, the test-database factory and model, temp directories.
- Found and fixed on the way:
  - the image's state directory was root-owned, so a busybox stage now prepares it;
  - the lab process could end once idle, so it now waits for a signal, and the orchestrator also cleans up anything left.

## Open (owner)
**The run on physical edge hardware** (`docs/edge-deployment.md` → Physical validation checklist): an install on the target host, real PLCs on a LAN, a cable pull, a 10-minute uplink cut with an agent restart, a 24-hour soak, upgrade and rollback, and a reboot. The kit and the stand-in make it a matter of running the checklist.

