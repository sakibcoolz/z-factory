# Z-Factory

Z-Factory is a browser-first virtual industrial factory platform for designing, executing, observing, testing, and exporting PLC-controlled factories.

> Status: documentation-first bootstrap. Feature development remains gated by the phase/task workflow in `docs/phases/`.

## MVP architecture
- One Next.js TypeScript full-stack application
- PostgreSQL + Prisma
- OpenPLC as the first executable PLC runtime
- Reusable Docker images orchestrated from server-only Next.js code
- One isolated Docker network per factory
- Modbus TCP as the first industrial protocol
- Compact and modular PLC catalog/data model
- Factory-specific device instances created from a reusable industrial device catalog
- React Flow network/wiring/topology designer
- Live tags, events, alarms, faults, and selected telemetry
- Shared device-simulator runtime for VFDs, motors, pumps, valves, sensors, switches and other peripherals
- External industrial edge/gateway connectivity
- PLC engineering print/export (PDF-oriented report plus machine-readable CSV/JSON/config package)
- Three.js / React Three Fiber 3D visualization in a later phase

## Core control principle

```text
External UI / Edge Gateway
          |
       Modbus TCP
          |
   PLC command/setpoint tags
          |
      OpenPLC logic
          |
 VFD / Valve / Output commands
          |
 Device simulation
          |
 feedback/status/alarm tags
          |
 Gateway + live Z-Factory UI
```

PLC logic is the control authority. External systems do not directly mutate motor, pump, VFD, or valve state.

## Runtime and persistence
Live PLC/device values live in the runtime/simulator layer. PostgreSQL stores catalog data, factory configuration, mappings, commands, important current state, alarms/events/audit history, versions, and selected/downsampled telemetry.

## AI-assisted development
Human maintainers work with Claude Code, GitHub Copilot, OpenAI Codex, Linear MCP, and Graphify. Every coding agent must start with `AGENTS.md` and the active task.

See `docs/README.md` for the complete documentation map.
