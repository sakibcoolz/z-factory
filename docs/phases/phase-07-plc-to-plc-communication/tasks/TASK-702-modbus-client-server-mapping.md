# TASK-702 — Modbus TCP Client/Server Mapping

Status: **DONE**
Linear: [ZFA-30](https://linear.app/recruit-verse/issue/ZFA-30)

## Goal
Define explicit Modbus TCP mappings for data exchange between PLC instances.

## Scope
- source PLC as Modbus TCP client
- target PLC as Modbus TCP server
- target Docker DNS/service name
- port and unit id
- remote Modbus area/address
- source/local PLC communication tag
- operation: READ or WRITE
- polling/update interval
- BOOL/INT16/UINT16/INT32/UINT32/FLOAT32 codecs
- word count, byte order and word order
- scaling and engineering units
- quality, stale and disconnected state
- register span and access validation

## Examples
```text
READ:
PLC-A(client) -> PLC-B(server) Input Register 30001
              -> PLC-A tag MACHINE_B_TEMP

WRITE:
PLC-A tag START_MACHINE_B
              -> PLC-B(server) Coil 00001
```

## Invariants
- Writes are allowed only to target endpoints configured as writable command/setpoint values.
- Feedback/status/process-value endpoints remain read-only.
- Existing Modbus data-type, address and access-mode rules are reused.
- A mapping must not silently bypass the target PLC's local control logic.

## Acceptance
- Read mappings transfer target PLC values into source PLC communication tags.
- Write mappings update only explicitly writable target endpoints.
- Type mismatch, invalid register span, address collision and invalid access mode are rejected.
- Stale/disconnected quality is visible to runtime and UI.

## Implementation (2026-10-06)
Design: docs/database.md → PlcCommunicationMapping; docs/architecture.md → PLC-to-PLC
communication (as built); docs/api-contract.md → `plc-communications`.

- Migration `20261006220000_plc_link_mappings`: enum `PlcLinkOperation` (READ, WRITE),
  table `PlcCommunicationMapping` (link, operation, local tag of the client, remote tag of the
  server, optional own interval, enabled), partial unique indexes for one READ per local tag
  and one WRITE per remote tag, CHECKs for distinct tags and the interval.
- Decision: the remote endpoint is a tag of the server PLC rather than a free area/address,
  so its area, address, type, word span, orders, scaling, unit and ADR-0015 authority come
  from the server's tag registry (recorded in docs/database.md).
- `checkLinkMapping` in `lib/domain/plc-communication.ts`: ends by link role, Modbus mapping,
  on/off vs number, unit; READ into free `%M` memory only; WRITE only from a value the
  client's program computes to external command memory of the server.
- New authority `LINK_INPUT` (`lib/domain/tag-authority.ts`) for tags a READ fills; shown in
  the Modbus map, the export and Live Tags.
- Service: `listPlcLinkMappings`, `addPlcLinkMapping` (one-writer check under a lock on the
  link), `updatePlcLinkMapping`, `removePlcLinkMapping`; every change bumps the link's version,
  snapshots the mappings by tag names and records `PLC_LINK_CHANGED`. The link export lists
  the mappings; the PLC export counts them.

Quality (GOOD / STALE / DISCONNECTED) is runtime state: the view carries `quality: null`
until the link runtime of TASK-703 fills it; the screens are TASK-704.

## Evidence
- `lib/domain/plc-communication.test.ts` (+4 mapping tests), report test.
- `test/integration/plc-link-mappings.test.ts` (6, PostgreSQL): reads and writes between two
  catalog PLCs with scaling and units; LINK_INPUT in the client's Modbus map; every refusal
  (server output and feedback not writable, gateway command not forwarded, READ into an
  output or command, wrong ends, type, unit, bad input); one writer per value across two
  links, with a concurrent race decided by the database; versions and export by name;
  removal and cascade with a tag.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 90 files, 992 tests passed
  (230 s); no test container or network left behind.
- Dev database: migration `plc_link_mappings` applied. No screen in this task.
- Graphify refreshed: 4226 nodes, 11190 edges, 227 communities.
