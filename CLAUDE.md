# Claude Code Instructions

Follow `AGENTS.md` as the authoritative repository contract.

Before coding:
- Read every mandatory document listed in `AGENTS.md`.
- Read the active phase README and task Markdown.
- Confirm prerequisites and acceptance criteria.
- Run/query Graphify before broad code exploration once a graph exists.
- Check the linked Linear issue and preserve its scope.

Architecture reminders:
- Next.js + TypeScript, PostgreSQL + Prisma.
- OpenPLC executes PLC code inside reusable Docker runtime containers.
- Each factory is isolated by its Docker network.
- PLC/device catalog definitions are separate from factory-specific instances.
- Device instances connect through validated I/O channels, tags, protocol endpoints, and relationships.
- Modbus TCP commands target PLC command/setpoint tags; PLC logic drives VFD/motor/pump/valve simulation.
- Live runtime state and persisted history are separate.
- Use shared simulator engines with per-device state unless an ADR says otherwise.
- PLC export/print is a first-class product requirement.

During coding:
- Prefer small, reviewable changes.
- Keep browser/client code isolated from server-only Docker and database modules.
- Do not bypass architecture boundaries to finish a task quickly.
- Update tests and docs with the implementation.

After coding:
- Run lint, typecheck, and relevant unit/integration tests.
- Update task Markdown status/evidence.
- Update Linear with completion notes and validation.
- Refresh Graphify after structural changes.
