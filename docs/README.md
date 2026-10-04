# Z-Factory Documentation Index

The repository is documentation-first. Coding starts only through an approved phase/task.

## Mandatory engineering documents
- [Current Status](./status.md)
- [Product](./product.md)
- [Architecture](./architecture.md)
- [Database](./database.md)
- [Design / UX](./design.md)
- [Engineering Rules](./rules.md)
- [Device Catalog](./device-catalog.md)
- [Device Simulation](./device-simulation.md)
- [OpenPLC Runtime](./openplc-runtime.md)
- [Docker Runtime](./docker-runtime.md)
- [Gateway & Modbus](./gateway-modbus.md)
- [PLC Export / Print](./plc-export.md)
- [Events & Telemetry](./events-telemetry.md)
- [Server API Contract](./api-contract.md)
- [Development Bootstrap](./bootstrap.md)
- [Coding Standards](./coding-standards.md)
- [Security](./security.md)
- [Testing](./testing.md)
- [PLC Source Policy](./references/plc-source-policy.md)
- [Graphify Workflow](./graphify.md)
- [Linear Workflow](./linear-workflow.md)
- [AI Agent Checklist](./ai-agent-checklist.md)
- [Architecture Decisions](./adr/)
- [Phases & Tasks](./phases/README.md)

## AI instruction entry points
- Root `AGENTS.md`: shared contract and primary instruction source.
- Root `CLAUDE.md`: Claude Code entry point.
- `.github/copilot-instructions.md`: GitHub Copilot entry point.
- Root `CODEX.md`: Codex entry point; `AGENTS.md` remains authoritative.

## Source of truth hierarchy
1. Approved active task file
2. `AGENTS.md`, rules, architecture, database, domain docs, and ADRs
3. Active phase plan
4. Linear issue
5. Code
6. Graphify generated graph

If two sources disagree, stop and resolve the documentation conflict before implementation.
