# process-sim

The Z-Factory process simulation service (ADR-0008, TASK-602): a deterministic tick loop
for many process-module instances behind a token-protected JSON API that only the
Z-Factory server talks to. The contract, the models and the lifecycle are described in
`docs/process-simulation.md`; this file is the developer's quick reference.

```sh
export PATH=$HOME/.local/go/bin:$PATH   # or wherever Go 1.26 is
cd services/process-sim
gofmt -l . && go vet ./... && go test -race ./...
PROCESS_SIM_TOKEN=$(openssl rand -hex 24) go run ./cmd/process-sim   # listens on 127.0.0.1:7700
```

Environment: `PROCESS_SIM_TOKEN` (required, at least 16 characters), `PROCESS_SIM_ADDR`
(default `127.0.0.1:7700`), `PROCESS_SIM_MAX_INSTANCES` (default 256).

Container: `docker compose --profile sim up process-sim` builds the image from this
directory and runs it with the limits of `compose.yaml`.
