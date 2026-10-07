# Edge Deployment — Thin Client Agent in Production

TASK-906, ADR-0023. This is how the Z-Factory Thin Client Agent goes onto an edge host (Raspberry Pi, industrial Linux gateway, Linux PC) and connects to Web Factory. The agent's design is in `docs/thin-client-agent.md`, and Web Factory's in `docs/web-factory.md`.

**Status:** the kit and the production-like stand-in run are done. The run on physical edge hardware has not happened yet: no edge host was available. It is the checklist at the end of this document.

## The kit
All of it is in `services/zfactory-thin-client-agent/packaging/`:

| File | What |
|---|---|
| `build.sh [version] [out]` | static Linux binaries for amd64, arm64 (Raspberry Pi 4/5, 64-bit OS) and armv7 (32-bit Raspberry Pi OS), and `SHA256SUMS-<version>`. Reproducible: two builds give the same checksums |
| `install.sh install\|upgrade\|uninstall` | the systemd install, checking the binary against its checksum |
| `zfactory-agent.service` | the hardened systemd unit |
| `agent.env.example` | the settings file, without secrets |
| `Dockerfile` | the same binary as a distroless image: non-root, about 4 MB, with a health check |
| `test-packaging.sh` | tests the kit without root: checksum refusal, layout and modes, upgrade, uninstall, purge, systemd's check of the unit |

## Install (systemd)
On a build machine with Go 1.26:

```sh
cd services/zfactory-thin-client-agent
packaging/build.sh 1.0.0            # dist/zfactory-agent-1.0.0-linux-{amd64,arm64,armv7}, SHA256SUMS-1.0.0
```

Copy the binary for the host's architecture (`uname -m`: `x86_64` is amd64, `aarch64` is arm64, `armv7l` is armv7), its `SHA256SUMS` file and the `packaging/` folder to the edge host. Then, as root:

```sh
packaging/install.sh install --binary zfactory-agent-1.0.0-linux-arm64 --sums SHA256SUMS-1.0.0
```

This creates the system user `zfactory-agent` and installs:
- the binary in `/usr/local/bin`;
- the unit;
- `/etc/zfactory-agent/agent.env`, from the example, created once and never overwritten;
- `/var/lib/zfactory-agent` for `staging/`, `active/`, `rejected/` and `spool/`.

A binary that does not match its checksum is refused.

## Configure and onboard
1. In Web Factory, an admin registers the agent on its site page, then clicks *Issue credentials* on the agent's page. Web Factory shows the password once, with the settings.
2. On the edge host, put the password alone in `/etc/zfactory-agent/mqtt-password` and the broker's CA certificate in `/etc/zfactory-agent/broker-ca.crt`. Both are mode 0640, owned by `root:zfactory-agent`.
3. Fill `/etc/zfactory-agent/agent.env`. The settings are in `docs/thin-client-agent.md`:
   - `ZFACTORY_AGENT_MQTT_URL=mqtts://<broker>:8883` (TLS in production);
   - the site and agent ids;
   - the client id and user name from Web Factory;
   - the password and CA file paths.
4. `systemctl start zfactory-agent`, then check with `curl -s 127.0.0.1:9180/healthz`.

No secret is ever in a deployment file, in `agent.env`, in the unit, in the container image or in a log. The password is read from its file, and the deployment files carry no credential (the stand-in run checks this).

## Deploy PLCs
Export each PLC from Z-Factory (PLC → Export → *Edge deployment (JSON)*), with the host and port at which the edge host reaches it. Copy the file into `staging/` under a temporary name, then rename it to `plc-<name>.json`.
- **Add or update:** the agent takes the file within its scan interval (2 s), without a restart. Workers of other PLCs are not disturbed.
- **Refused files:** a broken, tampered or older file goes to `rejected/`, with a `.reason.json`.
- **Remove:** delete the file from `active/` to stop that PLC.
- **Register in Web Factory:** upload the same file on the agent's page, so that Web Factory knows the PLC's tags and allow-list.

## Container instead of systemd
```sh
cd services/zfactory-thin-client-agent
docker build -f packaging/Dockerfile --build-arg VERSION=1.0.0 -t zfactory-agent:1.0.0 .
docker run -d --name zfactory-agent --restart unless-stopped --network host \
  --read-only --cap-drop ALL --security-opt no-new-privileges --memory 256m --pids-limit 512 \
  -v zfactory-agent-state:/var/lib/zfactory-agent \
  -v /etc/zfactory-agent:/etc/zfactory-agent:ro \
  --env-file /etc/zfactory-agent/agent.env zfactory-agent:1.0.0
```

The image runs as uid 65532 with a read-only root filesystem. A new named volume takes over the state directory's ownership. Its health check runs `zfactory-agent -probe`. `docker buildx build --platform linux/amd64,linux/arm64,linux/arm/v7` builds every architecture from the same `dist/`.

## Upgrade and roll back
```sh
packaging/install.sh upgrade --binary zfactory-agent-1.0.1-linux-arm64 --sums SHA256SUMS-1.0.1
```

The binary is replaced atomically, the old one is kept as `zfactory-agent.previous`, and the service restarts. Settings, deployment files and the offline spool stay; telemetry spooled during the restart is replayed.

To roll back, copy `/usr/local/bin/zfactory-agent.previous` over `zfactory-agent` and `systemctl restart zfactory-agent`.

`install.sh uninstall` keeps settings and state, including any telemetry not yet sent; `uninstall --purge` removes them.

## The broker in production
`apps/web-factory/broker/mosquitto-tls.conf` (ADR-0023):
- MQTT over TLS only, on 8883, with the server certificate from your CA;
- no anonymous access, Dynamic Security, queue limits.

Agents verify the broker with `ZFACTORY_AGENT_MQTT_CA_FILE`, and Web Factory with `WEB_FACTORY_MQTT_CA_FILE`. `broker/dev-ca.sh` makes a throwaway CA for tests and development only.

Plain 1883 (`mosquitto.conf`) is for development behind a loopback binding.

## Observe
`127.0.0.1:9180` serves:
- `/healthz`: `ok` or `degraded`, always 200 while the agent runs;
- `/v1/status`: the agent, its files, the queue, the uplink and each PLC;
- `/metrics`: Prometheus text.

Bind it to the LAN only if a monitoring agent must scrape it.

| Metric | Meaning |
|---|---|
| `zfactory_agent_workers{state}`, `zfactory_agent_plc_up{plc_id}` | PLC workers by state, and each PLC |
| `zfactory_agent_plc_polls_total`, `…_poll_failures_total`, `…_poll_duration_seconds`, `…_reconnects_total` | per PLC: polls, failures, the last poll's duration, reconnects |
| `zfactory_agent_active_configs`, `zfactory_agent_rejected_configs` | deployment files in force, and refused |
| `zfactory_agent_queue_depth`, `…_queue_dropped_total` | telemetry waiting for the uplink, and dropped because the queue was full |
| `zfactory_agent_spool_entries`, `…_bytes`, `…_oldest_age_seconds`, `…_dropped_total`, `…_written_total`, `…_replayed_total` | the offline spool |
| `zfactory_agent_mqtt_connected`, `…_connects_total`, `…_connections_lost_total`, `…_published_total` | the broker connection |
| `zfactory_agent_commands_total{outcome}` | cloud commands: received, accepted, rejected, applied, failed, duplicates, ack errors |
| `go_goroutines`, `go_memstats_heap_alloc_bytes`, `go_memstats_sys_bytes`, `process_cpu_seconds_total`, `process_max_resident_memory_bytes` | the agent's own resources |

Logs are JSON lines on stdout (journald or `docker logs`), with no secret.

Web Factory shows the same from the cloud side: agent and PLC connectivity, last seen, the heartbeat, alarms, and command status.

## Sizing
Measured in the stand-in run (below). On this development machine, 200 PLCs polled every 500 ms used tens of MiB and a few percent of one core. Start with the defaults:
- `MemoryMax=512M` in the unit, `--memory 256m` for the container;
- 64 concurrent polls and a 10,000-batch queue;
- a 256 MiB spool kept at most 7 days.

Raise the memory limit and `ZFACTORY_AGENT_MAX_CONCURRENT_POLLS` for many hundreds of PLCs. Size the spool for the longest cloud outage to be bridged: about (PLCs × polls per second × batch size) bytes per second. Every limit is in `agent.env`.

## Troubleshoot
| Symptom | Look at |
|---|---|
| Web Factory shows the agent offline | `systemctl status zfactory-agent`; `zfactory_agent_mqtt_connected`; the log's `broker connection lost` lines; the CA file and the clock (TLS) |
| `not authorised` in the broker log | the user name, client id and password file against Web Factory's agent page; credentials re-issued or revoked |
| A PLC stays disconnected | `/v1/plcs/{plcId}`: last error; the host and port in its file; the network path from the edge host |
| A file does not take | `rejected/<file>.reason.json` |
| The spool grows | the broker connection; `zfactory_agent_spool_oldest_age_seconds`; replay runs at `ZFACTORY_AGENT_REPLAY_RATE` |
| Commands rejected `stale-config-version` | the file the agent runs is older than the one registered in Web Factory: deploy the same version to both |

## Stand-in run (done)
`scripts/edge-standin.sh [report.json] [N] [OpenPLC runtimes]` (`apps/web-factory/test/edge-standin.test.ts`) is the closest stand-in for an edge host on one machine. It runs:
- the release container image, hardened: read-only, every capability dropped, not root, memory and process limits;
- with its state on disk across restarts;
- against a TLS-only broker, Web Factory, N simulated Modbus PLCs, and real OpenPLC runtimes running an IEC 61131-3 program with an interlock (`test/edge-standin/plc-lab.ts`, through Z-Factory).

It checks:
- TLS: an unverified broker is refused;
- hot add of every PLC;
- the other PLCs' poll rate while one PLC is slow and one is gone;
- refused broken and tampered files;
- a hot update;
- commands through the PLC's own logic: the interlock holds, the machine runs once the program allows it, and a redelivered command is not written twice;
- a broker outage with an agent restart inside it, replayed completely and stored once;
- the spool bounded under pressure;
- resources;
- that no secret is in a deployment file or the container's environment.

The measured report of the last run is in TASK-906's evidence.

## Physical validation checklist (open)
Run on the target edge host, with real PLCs on a real LAN, and keep the output as evidence. It needs an edge host, two or more PLCs (or OpenPLC on separate hardware), the production broker with TLS, and Web Factory.

1. Build and install with `install.sh install`, checking the checksum. Record `uname -m`, the OS, `zfactory-agent -version`, and `systemctl status`.
2. Onboard the agent in Web Factory, start the service, and see it online in Web Factory within one heartbeat.
3. Deploy every PLC file, and see each PLC online with live values. Record `/metrics` (workers, poll durations).
4. Unplug one PLC's network cable. That PLC shows disconnected and raises an alarm in Web Factory; the others' `polls_total` keep rising at their rate. Plug it back in and see it recover.
5. Drop a broken file and a tampered file into `staging/`: both end in `rejected/`, and nothing that runs changes.
6. Deploy a new version of one PLC file (another poll interval). Only that worker restarts; register the same version in Web Factory.
7. Send a command and a setpoint from Web Factory. Check:
   - the PLC program's interlock holds;
   - the read-back and the telemetry confirm the value;
   - a stop works.
8. Cut the edge host's uplink, or stop the broker, for 10 minutes, and restart the agent during the cut. The spool grows, and local polling goes on. After reconnecting, the spool drains, and Web Factory's history has no gap and no duplicates.
9. Fill the spool with a small `ZFACTORY_AGENT_SPOOL_MAX_BYTES`: it stays at its limit and counts drops.
10. Run 24 hours. Record CPU (`process_cpu_seconds_total`), memory (`process_max_resident_memory_bytes`, `systemctl status` memory) and goroutines: they must stay flat.
11. Upgrade with `install.sh upgrade` while PLCs run, roll back, and confirm no deployment or spooled telemetry is lost.
12. Reboot the host: the agent comes back by itself with its PLCs and spool.
