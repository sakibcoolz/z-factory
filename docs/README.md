# Z-Factory Documentation Index

The repository is documentation-first. Coding begins only after Phase 00 gates are satisfied.

## Mandatory engineering documents
- [Current Status](./status.md)
- [Product](./product.md)
- [Architecture](./architecture.md)
- [Database](./database.md)
- [Design / UX](./design.md)
- [Engineering Rules](./rules.md)
- [Coding Standards](./coding-standards.md)
- [Security](./security.md)
- [Testing](./testing.md)
- [Server API Contract](./api-contract.md)
- [Device Catalog](./device-catalog.md)
- [PLC Source Policy](./references/plc-source-policy.md)
- [OpenPLC Runtime](./openplc-runtime.md)
- [Docker Runtime](./docker-runtime.md)
- [Events & Telemetry](./events-telemetry.md)
- [Graphify Workflow](./graphify.md)
- [Linear Workflow](./linear-workflow.md)
- [AI Agent Checklist](./ai-agent-checklist.md)
- [Architecture Decisions](./adr/)
- [Phases & Tasks](./phases/README.md)

## AI instruction entry points
- Root `AGENTS.md`: shared contract for every coding agent and primary Codex instruction file.
- Root `CLAUDE.md`: Claude Code entry point.
- `.github/copilot-instructions.md`: GitHub Copilot entry point.
- Root `CODEX.md`: human-readable pointer for Codex; `AGENTS.md` remains authoritative.

## Source of truth hierarchy
1. Approved active task file
2. `AGENTS.md` + engineering rules/architecture/database/ADRs
3. Active phase plan
4. Linear issue
5. Code
6. Graphify generated graph

If two sources disagree, stop and resolve the documentation conflict before implementation.
