# ADR-0023 — Production Edge Deployment and Transport Security

Status: **ACCEPTED** (TASK-906, 2026-10-07)

## Context
MVP 2 needs the Thin Client Agent on real edge hosts, connected to Web Factory over a network that is not trusted, with a repeatable deployment, bounded resources and evidence for each failure mode. No physical edge host was available when TASK-906 ran. Agents already authenticate with per-agent Dynamic Security passwords (ADR-0019), and the passwords travel in Dynamic Security commands.

## Decision
1. **Owner decision: no hardware yet.** The task delivers a deployment kit and a production-like stand-in run on the development machine. The run on physical hardware stays open, as a checklist (`docs/edge-deployment.md`). Nothing claims a physical validation that did not happen.
2. **Transport, owner decision:** MQTT over TLS only in production (`broker/mosquitto-tls.conf`: listener 8883, TLS 1.2 at least, the server certificate from the operator's CA).
   - Agents (`ZFACTORY_AGENT_MQTT_CA_FILE`) and Web Factory (`WEB_FACTORY_MQTT_CA_FILE`) verify it and keep their per-agent passwords. No mTLS.
   - Plain 1883 is for development behind a loopback binding. `broker/dev-ca.sh` makes a throwaway CA for tests only.
3. **One binary, two ways to run it:**
   - **Build:** static (no cgo), reproducible builds for linux/amd64, arm64 and armv7, with a SHA256SUMS file (`packaging/build.sh`).
   - **systemd:** `packaging/install.sh` refuses a binary that does not match its checksum, installs a hardened unit, keeps settings and state across upgrades, and keeps the previous binary for rollback.
   - **Container:** a distroless, non-root image of the same binary, run with a read-only root and no capabilities.
4. **Where things live:**
   - settings: `/etc/zfactory-agent/agent.env`, without secrets;
   - secrets: files beside it (`mqtt-password`, `broker-ca.crt`), mode 0640, readable by the service group only;
   - state: `/var/lib/zfactory-agent` (`StateDirectory`), surviving upgrades and restarts, spool included.
5. **Resources are bounded and visible.** The unit sets `MemoryMax`, `TasksMax` and `LimitNOFILE`, and the container memory and process limits. The agent exposes its goroutines, memory, CPU time, per-PLC poll duration and failures, and its MQTT, spool and command counters on `/metrics`. `zfactory-agent -probe` is the container's health check.
6. **The stand-in run is a test, repeatable on any Docker host:** `scripts/edge-standin.sh`, `apps/web-factory/test/edge-standin.test.ts`. It runs the release image hardened, a TLS broker, Web Factory, N simulated PLCs, and real OpenPLC runtimes running a program with an interlock, started through Z-Factory (`test/edge-standin/plc-lab.ts`). It exercises every failure in the task and writes a measured report.

## Consequences
- **Certificates:** operators run a CA (or use a public one) for the broker, and distribute its certificate to edge hosts with the password file.
- **Physical evidence:** real network timing, ARM performance and 24-hour stability come from the physical checklist when hardware is available, and are recorded then.
- **Not built:** mTLS would need certificate issuance per agent and a new decision.
