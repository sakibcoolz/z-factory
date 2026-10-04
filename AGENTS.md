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
9. `docs/device-catalog.md`
10. `docs/device-simulation.md`
11. `docs/openplc-runtime.md`
12. `docs/docker-runtime.md`
13. `docs/gateway-modbus.md`
14. `docs/plc-export.md`
15. `docs/events-telemetry.md`
16. `docs/api-contract.md`
17. `docs/coding-standards.md`
18. `docs/security.md`
19. `docs/testing.md`
20. `docs/references/plc-source-policy.md`
21. `docs/graphify.md`
22. `docs/linear-workflow.md`
23. Relevant ADRs under `docs/adr/`
24. Active phase README and active task file under `docs/phases/`
25. `docs/ai-agent-checklist.md`

## Non-negotiable architecture rules
- Documentation-first. Do not implement a task whose task file is missing or not Ready/In Progress.
- MVP is one Next.js TypeScript application; do not introduce an independent backend service without an approved ADR.
- PostgreSQL + Prisma are the primary persistence layer.
- Docker access is server-only. Never expose Docker socket/API credentials to browser code.
- OpenPLC is the first executable PLC runtime. Vendor PLC names/models are hardware profiles, not vendor firmware emulation.
- A PLC created in the UI is an abstraction. Backend generation produces PLC instance records, runtime config, I/O/tag/Modbus maps, container config, network attachment, health state, and program artifacts.
- Prefer reusable versioned runtime images. Do not create a unique Dockerfile/image for each PLC/device unless a custom image is genuinely required.
- One factory gets one isolated Docker network by default.
- Compact and modular PLCs are modeled differently in database, validation, UI, and runtime mapping.
- Modbus TCP is the MVP industrial protocol.
- PLC identity = manufacturer + family + exact model; machine/process role is separate metadata.
- Factory devices are instances created from reusable catalog models. Instance names must be unique within the factory.
- Device connections must reference valid PLC channels, tags, Modbus addresses, or device relationships and must reject incompatible wiring.
- PLC logic remains the control authority. External gateways write PLC command/setpoint tags; they must not directly mutate motor/pump/VFD simulator state.
- Command/setpoint tags are distinct from feedback/status/alarm tags.
- Live runtime state is not sourced from PostgreSQL. Runtime memory/simulator state is authoritative for live values; PostgreSQL stores configuration, important current state, commands, events, alarms, audit history, and selected/downsampled telemetry.
- VFD simulation uses one generic simulator engine with factory-specific VFD instances unless an ADR changes the runtime model. MVP relation: one VFD -> one primary motor.
- Device simulators must model appropriate behavior: sensors generate process values; switches discrete states; valves react to commands; VFDs ramp and report feedback; motors react to drive output; pumps/fans/conveyors react to motor state.
- Every PLC instance must support a complete engineering export containing specs, I/O, tags, Modbus map, connected devices, pin/channel assignments, runtime/version metadata, and topology.
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
