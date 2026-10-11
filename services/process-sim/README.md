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
(default `127.0.0.1:7700`), `PROCESS_SIM_MAX_INSTANCES` (default 256, process-module
instances), `PROCESS_SIM_MAX_DEVICES` (default 2048, devices of the catalog device runtime
over all factories).

Since TASK-1009 the service also hosts the catalog device runtime (ADR-0025): behaviour
profiles in `internal/device` (one file per profile, the factory simulation that couples
them in `simulation.go`), the host of many factories in `internal/runtime`, and the
`/v1/factories` and `/v1/profiles` routes in `internal/api/devices.go`. A new profile is
one file that calls `device.Register` from `init`; `simulation_test.go` checks every
registered profile describes itself and runs with its defaults.

Container: `docker compose --profile sim up process-sim` builds the image from this
directory and runs it with the limits of `compose.yaml`.
