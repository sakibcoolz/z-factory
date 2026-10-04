# Z-Factory

Z-Factory is a browser-first virtual industrial factory platform for creating, running, observing, and testing simulated PLC-based factories.

> Status: documentation-first bootstrap. Application development must not begin until Phase 0 documentation and architecture gates are complete.

## MVP
- Next.js full-stack application (SSR/server components where appropriate)
- TypeScript-only application layer
- OpenPLC as the first PLC runtime
- Docker/Docker Compose orchestration from server-only Next.js code
- Modbus TCP as the first industrial protocol
- Compact and modular PLC catalog/data model
- React Flow network/topology designer
- Three.js / React Three Fiber 3D factory visualization
- Live device events and telemetry
- External Raspberry Pi / edge-gateway connectivity through exposed host ports

## AI-assisted development
This repository is intended to be developed by human maintainers together with Claude Code, GitHub Copilot, OpenAI Codex, Linear MCP, and Graphify.

All coding agents **must read**:
1. `AGENTS.md`
2. `docs/rules.md`
3. `docs/architecture.md`
4. `docs/database.md`
5. `docs/design.md`
6. `docs/device-catalog.md`
7. `docs/openplc-runtime.md`
8. `docs/linear-workflow.md`
9. the active phase file under `docs/phases/`
10. the active task file under that phase's `tasks/`

See `docs/README.md` for the documentation map and execution workflow.
