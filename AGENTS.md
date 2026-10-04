# Z-Factory AI Agent Contract

This file is mandatory reading for Claude Code, GitHub Copilot, OpenAI Codex, and any automated coding agent.

## Read order before changing code
1. `README.md`
2. `docs/README.md`
3. `docs/rules.md`
4. `docs/product.md`
5. `docs/architecture.md`
6. `docs/database.md`
7. `docs/design.md`
8. `docs/device-catalog.md`
9. `docs/openplc-runtime.md`
10. `docs/docker-runtime.md`
11. `docs/events-telemetry.md`
12. `docs/graphify.md`
13. `docs/linear-workflow.md`
14. Active phase README and task file.

## Non-negotiable rules
- Documentation-first. Do not implement a task whose task file is missing or not Ready/In Progress.
- MVP is one Next.js application; do not introduce an independent backend service without an ADR.
- Docker access is server-only. Never expose Docker socket/API credentials to browser code.
- OpenPLC is the first PLC runtime. Vendor PLC entries are hardware/profile metadata unless an explicitly supported runtime adapter exists.
- Compact and modular PLCs are modeled differently.
- Modbus TCP is the first industrial protocol.
- Never claim an OpenPLC container is actual Siemens/Rockwell/Schneider firmware.
- Do not store vendor manuals, images, CAD, firmware, or copyrighted artifacts unless licensing permits it; store source URLs and normalized facts.
- Every schema change requires updating `docs/database.md`.
- Every architecture change requires updating `docs/architecture.md`.
- Every task status change must be mirrored in its Markdown task file and Linear.
- Before cross-cutting changes, query/update Graphify as described in `docs/graphify.md`.
- Add tests with each behavior change.
- No secrets in Git.

## Definition of Done
A task is Done only when code, tests, docs, task status, Linear issue status, and Graphify refresh/impact check are complete.
