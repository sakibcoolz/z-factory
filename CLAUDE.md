# Claude Code Instructions

Follow `AGENTS.md` as the primary agent contract.

Before coding:
- Read the active phase README and task Markdown.
- Confirm prerequisites and acceptance criteria.
- Run/query Graphify before broad code exploration once a graph exists.
- Check the linked Linear issue and preserve its scope.

During coding:
- Prefer small, reviewable changes.
- Keep browser/client code isolated from server-only Docker and database modules.
- Do not bypass architecture boundaries to finish a task quickly.
- Update tests and docs with the implementation.

After coding:
- Run lint, typecheck, unit/integration tests relevant to the change.
- Update task Markdown status/evidence.
- Update Linear with completion notes and validation.
- Refresh Graphify after structural changes.
