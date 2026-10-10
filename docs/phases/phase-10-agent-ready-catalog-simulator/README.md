# Phase 10 — Agent-Ready Engineering & Full Catalog Go Simulation

Status: **IN PROGRESS** (TASK-1001 started 2026-10-09)

## Goal

Make Z-Factory Engineering reliably understandable and operable by external browser-based AI agents while expanding the Go simulator into a catalog-driven industrial device simulation platform.

Phase 10 has two parallel workstreams:

1. **Agent-ready engineering UX** — every active engineering area exposes a structured LLM Context tab, the home page exposes a global LLM Index and agent guide, and inactive navigation is removed from the production sidebar.
2. **Full catalog Go simulation** — catalog devices that do not have a legal/usable vendor runtime or Docker image receive documented behavior models in a shared Go simulator. Z-Factory never claims vendor firmware emulation unless it truly runs an approved runtime.

## Architecture principles

### External browser agent boundary

Z-Factory does **not** embed Claude, Codex, Grok, MCP, or a third-party LLM API for this phase.

```text
External browser/coding agent
        |
        v
Z-Factory normal web UI
        |
        +--> Home LLM Index
        +--> Page-level LLM Context
        +--> Normal user controls
        |
        v
Z-Factory services + validation
        |
        v
Database / runtime / simulator
```

The agent reads visible application context, asks the user for missing decisions, recommends changes and uses supported UI flows. It does not bypass validation or manipulate hidden database/runtime interfaces.

### Simulation fidelity boundary

If a catalog device has no legal/usable vendor runtime, emulator or Docker image, Z-Factory simulates documented behavior rather than pretending to execute vendor firmware.

Simulation coverage is explicit per catalog model:

- **FULL** — all Z-Factory-declared behavioral features are implemented.
- **PARTIAL** — some declared features are implemented.
- **GENERIC** — category-level behavior only.
- **NOT_SIMULATABLE** — metadata/configuration only; no executable behavior.

## Phase 10 execution tasks

| Task | Status | Scope |
|---|---|---|
| TASK-1001 | DONE | Global LLM Index & complete agent guide |
| TASK-1002 | DONE | Reusable page-level LLM Context framework |
| TASK-1003 | DONE | LLM Context tabs across active engineering pages |
| TASK-1004 | DONE | Agent navigation index and cross-page guidance |
| TASK-1005 | PLANNED | Sidebar cleanup and active-feature navigation |
| TASK-1006 | PLANNED | User-decision and recommendation guidance |
| TASK-1007 | PLANNED | Agent-readable validation and error explanations |
| TASK-1008 | PLANNED | Browser-agent end-to-end engineering validation |
| TASK-1009 | PLANNED | Go Catalog Simulation Runtime foundation |
| TASK-1010 | PLANNED | Catalog device capability and behavior schema |
| TASK-1011 | PLANNED | Full industrial device behavior library |
| TASK-1012 | PLANNED | Vendor catalog model to simulation-profile mapping |
| TASK-1013 | PLANNED | Protocol/register-controlled device simulation |
| TASK-1014 | PLANNED | Fault, failure and degraded-quality simulation |
| TASK-1015 | PLANNED | Dynamic catalog-driven simulator instantiation |
| TASK-1016 | PLANNED | Catalog simulation coverage report and validation |

## Agent-ready engineering acceptance boundary

- Home page exposes one authoritative LLM Index for the complete engineering application.
- Every active engineering page exposes a consistent LLM Context tab.
- LLM Context is structured, concise, current and derived from the same data/services as the human UI.
- Context includes current objects, relationships, capacities, validation state, constraints, available actions and navigation hints.
- Missing engineering decisions are explicitly identified for the browser agent to ask the user.
- The agent can complete a representative factory engineering workflow using only visible Z-Factory pages and normal UI controls.
- No MCP or embedded LLM integration is required.
- Inactive, duplicate and future-only sidebar entries are hidden from normal production navigation.

## Go simulator acceptance boundary

The Go catalog simulator must support behavior profiles across the industrial catalog, including where applicable:

- PLC/RTU/controller-facing simulated interfaces
- VFDs, servo drives and soft starters
- motors and servo motors
- pumps, fans, blowers, conveyors, feeders, mixers, agitators and compressors
- solenoid and modulating/control valves
- pneumatic actuators/cylinders
- relays, contactors and SSRs
- heaters and simple thermal loads
- stack lights, alarm lamps and buzzers
- push buttons, selectors, limit/float/pressure switches and E-stop status contacts
- proximity and photoelectric sensors
- temperature, pressure, level, flow, humidity, vibration, current, voltage and position sensors/transmitters
- encoders
- PID/process/temperature controllers
- remote I/O and distributed I/O
- IO-Link masters
- protocol converters and industrial gateways
- signal conditioners/isolators and analog converters
- intelligent motor protection/starter devices
- industrial edge/gateway metadata where simulation is meaningful

Each model declares commands, feedback, parameters, timing, state transitions, limits, faults, quality behavior and relationships only where Z-Factory has an explicit documented model.

## Exit criteria

Phase 10 is complete when:

- agent-facing index/context coverage exists for every active engineering workflow;
- browser-agent E2E tests prove the UI can be understood and operated without private interfaces;
- sidebar navigation exposes only usable product functionality;
- the Go simulator is catalog-driven rather than hard-coded to a small device subset;
- every catalog model has an explicit simulation coverage state;
- all supported behavior models are deterministic and testable;
- protocol/register simulation never invents vendor maps without authoritative source data;
- PLC program/output authority remains unchanged;
- documentation clearly distinguishes generic behavior simulation from real vendor firmware/runtime execution.
