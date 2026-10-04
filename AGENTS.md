# Z-Factory AI Agent Contract

This file is mandatory reading for Claude Code, GitHub Copilot, OpenAI Codex, and any automated coding agent.

## Read order before changing code
1. `README.md`
2. `docs/README.md`
3. `docs/status.md`
4. `docs/rules.md`
5. `docs/product.md`
6. `docs/architecture.md`
7. `docs/database.md`
8. `docs/design.md`
9. `docs/coding-standards.md`
10. `docs/security.md`
11. `docs/testing.md`
12. `docs/api-contract.md`
13. `docs/device-catalog.md`
14. `docs/references/plc-source-policy.md`
15. `docs/openplc-runtime.md`
16. `docs/docker-runtime.md`
17. `docs/events-telemetry.md`
18. `docs/graphify.md`
19. `docs/linear-workflow.md`
20. Relevant ADRs under `docs/adr/`
21. Active phase README and active task file under `docs/phases/`
22. `docs/ai-agent-checklist.md`

## Non-negotiable rules
- Documentation-first. Do not implement a task whose task file is missing or not Ready/In Progress.
- MVP is one Next.js application; do not introduce an independent backend service without an approved ADR.
- Docker access is server-only. Never expose Docker socket/API credentials to browser code.
- OpenPLC is the first PLC runtime. Vendor PLC entries are hardware/profile metadata unless an explicitly supported runtime adapter exists.
- Compact and modular PLCs are modeled differently in database, validation, UI, and runtime mapping.
- Modbus TCP is the first industrial protocol.
- Never claim an OpenPLC container is actual Siemens/Rockwell/Schneider firmware.
- Never invent vendor specifications. Store authoritative source provenance.
- Do not store vendor manuals, firmware, images or CAD unless licensing permits it; store normalized facts and source references.
- Every schema change requires updating `docs/database.md`.
- Every architecture change requires updating `docs/architecture.md` and, for durable decisions, an ADR.
- Every task status/scope change must be mirrored in its Markdown task file and Linear.
- Before cross-cutting changes, query Graphify as described in `docs/graphify.md` once a graph exists.
- Refresh Graphify after structural changes.
- Add tests with each behavior change.
- No secrets in Git.

## Task execution protocol
1. Locate exactly one active task.
2. Verify prerequisites.
3. Mark task `IN PROGRESS` in Markdown and Linear.
4. Query Graphify for impacted code when available.
5. Implement only the approved task scope.
6. Run required validation.
7. Record evidence/notes in task Markdown.
8. Refresh Graphify when structure changed.
9. Update Linear.
10. Mark `DONE` only when acceptance criteria pass.

## Definition of Done
A task is Done only when code, tests, docs, task status, Linear issue status, and Graphify impact/refresh requirements are complete.
