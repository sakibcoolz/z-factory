# TASK-701 — PLC Relationship & Communication Domain

Status: **DONE**
Linear: [ZFA-29](https://linear.app/recruit-verse/issue/ZFA-29)

## User story
As a Z-Factory engineer, I want to define a communication relationship between two PLC instances so that one PLC can coordinate, monitor or exchange data with another PLC without merging their programs or runtimes.

## Scope
- source PLC and target PLC
- relationship type: `COMMUNICATES_WITH` or `SUPERVISES`
- protocol selection
- logical role metadata: client/server
- enable/disable state
- same-factory validation
- configuration versioning
- repositories, validation and tests

## Invariants
- Source and target must be different PLC instances.
- Both PLCs must belong to the same factory in this phase.
- A relationship does not imply unrestricted write access.
- Each PLC retains its own program, container, lifecycle and local control logic.

## Acceptance
- PLC relationships can be created, updated, listed and removed.
- Self-links and cross-factory links are rejected.
- Relationship configuration is versioned and exportable.

## Implementation (2026-10-06)
Design: docs/architecture.md → PLC-to-PLC communication (as built); docs/database.md →
PlcCommunicationConnection; docs/api-contract.md → `plc-communications`.

- Migration `20261006200000_plc_communications`: enum `PlcRelationship`
  (`COMMUNICATES_WITH`, `SUPERVISES`), scope `PLC_COMMUNICATION`, table
  `PlcCommunicationConnection` (source, target, relationship, protocol, client and server
  PLC, `serverHost`, port, unit id, poll interval, enabled, `configVersion`) with CHECKs for
  distinct PLCs, roles and endpoint ranges, unique per ordered pair and protocol.
- `lib/domain/plc-communication.ts` — `checkPlcLink` (self, same factory, programmable
  controllers, server capability for the protocol by the chosen client end),
  `plcLinkServerHost` (the server PLC's deterministic service name), the view and snapshot
  shapes (`z-factory.plc-link` v1). `serviceNameFor` moved to `lib/domain/service-name.ts`
  (re-exported by the runtime service).
- `lib/services/plc-communication-service.ts` — list, get, create, update, enable/disable,
  delete, versions, export, and the links of a PLC for its export; every change bumps
  `configVersion`, stores a `ConfigurationVersion` snapshot and records `PLC_LINK_CHANGED`.
- `lib/validation/plc-communication.ts`, `lib/db/repositories/plc-communication-repository.ts`,
  constraint messages in `lib/db/errors.ts`.
- PLC engineering export: `network.plcLinks` in the document and a table in section 11.

Mappings (TASK-702), the runtime adapter and Docker networking (TASK-703) and the screens,
topology edge and E2E (TASK-704) follow; `mappingCount` is 0 until TASK-702.

## Evidence
- `lib/domain/plc-communication.test.ts` (5), `components/export/plc-report.test.tsx` (link row).
- `test/integration/plc-communication.test.ts` (6, PostgreSQL): roles and server name,
  refusals (self, cross-factory both ways, non-controller, duplicate, unknown relationship,
  out-of-range poll), a link to a programmable RTU, versions following the roles and the
  enabled flag with their events, export by names and in both PLCs' exports, another
  owner, history kept after removal, removal with the PLC.

## Validation (2026-10-06)
- `npx prettier --check .` — clean. `npm run lint` — clean. `npx tsc --noEmit` — clean.
- `npm run build` — succeeds.
- `services/process-sim`: `gofmt -l` clean, `go vet ./...` clean, `go test -race ./...` green.
- `TEST_DOCKER=1 PROCESS_SIM_BIN=<built binary> npm test` — 89 files, 982 tests passed
  (227 s); no test container or network left behind.
- Dev database: migration `plc_communications` applied. No screen in this task; the PLC
  export's new table is covered by the report test.
- Graphify refreshed: 4196 nodes, 11088 edges, 261 communities.
