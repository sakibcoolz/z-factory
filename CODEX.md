# OpenAI Codex Instructions

OpenAI Codex must treat `AGENTS.md` as the authoritative repository instruction file.

Before implementation:
1. Read `AGENTS.md`.
2. Read every mandatory document listed there.
3. Read the active phase and task file.
4. Check the matching Linear issue.
5. Use Graphify for codebase navigation/impact analysis when a graph exists.

Do not start an unplanned task, invent industrial hardware facts, expose Docker privileges to the browser, bypass compact/modular PLC validation, make PostgreSQL the source of live PLC state, or let a gateway bypass PLC control logic.

Keep these domain boundaries intact:
- catalog model != factory device instance;
- hardware profile != OpenPLC runtime;
- command/setpoint != feedback;
- live runtime state != persisted history;
- one VFD instance -> one primary motor for MVP;
- device simulation uses explicit, testable state machines/physics approximations;
- every PLC can export its engineering configuration.

When work finishes, update tests, documentation, task evidence/status, Linear, and Graphify as required by `AGENTS.md`.
