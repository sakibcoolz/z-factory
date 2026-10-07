# zfactory-agent

The Z-Factory Thin Client Agent (TASK-503): a standalone Go service for an edge host
(Raspberry Pi, industrial gateway, Linux PC) that runs the PLCs deployed to it from files
Z-Factory exports. It has no database and imports nothing from the Next.js application.
The design, file lifecycle and limits are in `docs/thin-client-agent.md`; this is the
developer's quick reference.

```sh
export PATH=$HOME/.local/go/bin:$PATH   # or wherever Go 1.26 is
cd services/zfactory-thin-client-agent
gofmt -l . && go vet ./... && go test -race ./...
ZFACTORY_AGENT_LOAD_N=1000 go test -run TestManyPLCs -v ./internal/agent   # larger load test
go build -o zfactory-agent ./cmd/zfactory-agent
./zfactory-agent -dir ./edge -health 127.0.0.1:9180
```

Deploy a PLC: download *Edge deployment (JSON)* from the PLC's Export screen
(`/factories/{factory}/plcs/{plc}/edge.json`, optional `host`, `port`, `unitId`,
`pollIntervalMs`, `timeoutMs` query parameters), copy it to `staging/` under a temporary
name and rename it to `plc-<name>.json`. Remove it from `active/` to stop that PLC.

| Flag | Environment | Default |
|---|---|---|
| `-dir` | `ZFACTORY_AGENT_DIR` | `/etc/zfactory-agent` |
| `-health` | `ZFACTORY_AGENT_HEALTH_ADDR` | `127.0.0.1:9180` |
| `-scan` | `ZFACTORY_AGENT_SCAN_INTERVAL` | `2s` |
| `-settle` | `ZFACTORY_AGENT_SETTLE` | `1s` |
| `-max-concurrent-polls` | `ZFACTORY_AGENT_MAX_CONCURRENT_POLLS` | `64` |
| `-queue` | `ZFACTORY_AGENT_QUEUE` | `10000` |

MQTT (optional): `-mqtt-url` / `ZFACTORY_AGENT_MQTT_URL` with `-site-id` and `-agent-id`;
credentials by `-mqtt-username` and `-mqtt-password-file`, TLS by `-mqtt-ca-file`,
`-mqtt-cert-file`, `-mqtt-key-file`. Topics and the command contract are in
`docs/thin-client-agent.md` → MQTT. The MQTT tests need Docker:

```sh
ZFACTORY_AGENT_DOCKER=1 go test -race ./internal/uplink   # runs eclipse-mosquitto:2
```

Health: `GET /healthz`, `/v1/status`, `/v1/plcs/{plcId}`, `/metrics`; `zfactory-agent -probe`
asks a running agent and exits 0 or 1 (container health checks).

Offline spool (with MQTT): `spool/telemetry.db`, bounded by `-spool-max-bytes` (256 MiB)
and `-spool-max-age` (7 days), replayed at `-replay-rate` (50 batches/s) after a reconnect.

Production (TASK-906, `docs/edge-deployment.md`):

```sh
packaging/build.sh 1.0.0          # dist/: linux amd64, arm64, armv7 + SHA256SUMS-1.0.0 (reproducible)
packaging/install.sh install --binary dist/zfactory-agent-1.0.0-linux-arm64 --sums dist/SHA256SUMS-1.0.0   # as root
docker build -f packaging/Dockerfile --build-arg VERSION=1.0.0 -t zfactory-agent:1.0.0 .
packaging/test-packaging.sh       # tests the kit without root
```
