# TASK-703 — PLC-to-PLC Runtime Adapter & Docker Networking

Status: **DONE**
Linear: [ZFA-31](https://linear.app/recruit-verse/issue/ZFA-31)

## Goal
Make independently running OpenPLC containers communicate through Modbus TCP on the isolated factory Docker network.

## Scope
- deterministic Docker DNS/service name per PLC
- internal Modbus TCP endpoint discovery
- client connection lifecycle
- connection timeout/retry/backoff
- polling scheduler
- read/write execution
- runtime health and communication quality
- structured events for connect/disconnect/error/recovery
- no hard-coded container IP addresses
- integration tests with two OpenPLC containers

## Runtime flow
```text
PLC-A Program
   |
   | local communication tag
   v
PLC-to-PLC Modbus Client Adapter
   |
   | factory Docker network
   v
PLC-B OpenPLC Modbus Server
   |
   v
PLC-B tag/register -> PLC-B local logic
```

## Invariants
- Containers communicate by deterministic service/DNS name, not fixed IP.
- Host-published ports are not required for PLC-to-PLC traffic inside the factory network.
- One failed PLC link must not crash unrelated PLC runtimes.
- Retry behavior is bounded and observable.
- Runtime writes obey the mapping access rules from TASK-702.

## Acceptance
- Two PLC containers exchange configured values over the factory network.
- Restarting the target PLC produces disconnected/stale state and later recovery.
- Connection failures generate useful runtime events without corrupting tag state.

## Implementation (2026-10-06)
Design: docs/openplc-runtime.md → PLC-to-PLC links (TASK-703); docs/docker-runtime.md →
PLC-to-PLC traffic; docs/architecture.md → PLC-to-PLC communication (as built).

- Decision (ADR-0016): the client PLC's **own runtime** is the Modbus TCP client. The OpenPLC Runtime
  v4 image ships a Modbus master plugin (`core/src/drivers/plugins/python/modbus_master`),
  enabled by `conf/modbus_master.json` in the upload bundle. So the exchange runs container to
  container on the factory network, by service name, with no Z-Factory process or host port in
  the path, exactly as a supervisor PLC would poll a machine PLC.
- `lib/runtimes/openplc/bundle.ts` — `modbusMasterConfig` (one device per link: server service
  name, port, unit id, timeout; one point per mapping: function code by area and direction,
  remote offset, local located address, interval, keep last value on failure);
  `composeProgramBundle`/`deployProgram` take the devices.
- `modbusMasterPlan` (plc-communication-service) builds them from the client's enabled links
  and mappings; `deployProgramVersion` deploys them with the program and records the link
  versions in the deployment snapshot (`plcLinks`).
- Rules tightened to what the plugin carries (`plc-link-adapter`): same type, scale and offset;
  BOOL/INT16/UINT16 only; READ bits in `%IX`, WRITE bits from `%QX`; READ local may be `%I` or
  `%M` (was `%M` only). `LINK_INPUT` now also covers `%I` tags a link fills.
- `lib/runtimes/plc-link/monitor.ts` — `PlcLinkMonitorRuntime`: per factory, evaluates each
  enabled link (STALE: client not running or not running the current link version;
  DISCONNECTED: server does not answer a Modbus probe; GOOD otherwise), reports changes once.
  Service: `startPlcLinkMonitor`, `stopPlcLinkMonitor`, `getPlcLinkHealth`; changes recorded
  as `CONNECTION_DOWN`/`CONNECTION_UP` with `link: plc-link`. Started and stopped with the
  factory (`startFactory`/`stopFactory`, `getPlcLinkDeps`). Mapping views carry the link's
  quality when a monitor is passed.

Limits: 32-bit values are not carried (plugin word order); a link change needs the client to
be redeployed (shown as STALE until then); the health probe reads the server from the host,
not from inside the client — it shows whether the server answers, not every exchange.

## Evidence
- `lib/runtimes/plc-link/monitor.test.ts` (2), `lib/runtimes/openplc/openplc.test.ts` (+1:
  the master configuration), `lib/domain/plc-communication.test.ts` (adapter rules).
- `test/integration/plc-link-runtime.test.ts` (3, Docker, two real OpenPLC runtimes, ~24 s):
  the link deployed with the client and recorded in its snapshot; link GOOD; a command given
  to the supervisor reaches the machine only through the supervisor's program and its runtime;
  the machine's running bit and counter arrive in the supervisor's `%IX`/`%MW` and its program
  echoes them; a gateway cannot write the link input; stopping the machine → DISCONNECTED,
  last value kept, supervisor still running; restart → GOOD, exchange resumes,
  `CONNECTION_DOWN`/`CONNECTION_UP` recorded.
- `test/integration/plc-link-mappings.test.ts` adjusted to the adapter rules.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 92 files, 999 tests passed
  (251 s); no test container or network left behind.
- No schema change. No screen in this task. ADR-0016 records where the link client runs.
- Graphify refreshed: 4274 nodes, 11330 edges, 235 communities.
