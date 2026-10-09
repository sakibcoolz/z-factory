# ADR-0024 — Agent-Ready Engineering: External Browser Agents, No Embedded Model

Status: **ACCEPTED** (TASK-1001, 2026-10-09)

## Context
Phase 10 makes Z-Factory Engineering understandable and operable by AI coding and browser agents that a user runs outside the product (Claude, Codex, Grok and the like, in a browser or against the running application). The product must stay one Next.js application (ADR-0001 era rules), the PLC program must stay the control authority (ADR-0015), and no agent may reach the database, Docker or a runtime behind the application's validation.

## Decision
1. **Z-Factory embeds no model and offers no MCP server in Phase 10.** The agent is the user's; it reads the application's visible context and uses the normal pages and controls. Everything it changes goes through the same services and validation a person's click goes through.
2. **A global LLM Index at `/llm-index`** (TASK-1001) is the first page an agent reads. It explains the product and its engineering model, lists every engineering area with its routes, says which pages have an LLM Context tab, gives the recommended workflow, and states the rules an agent follows. The same content is served as Markdown at `/llm-index.md` for agents that fetch rather than render.
3. **The index is derived, not written.** One registry (`lib/agent/llm-index.ts`) names the route builder each entry covers and the activity-bar entry it belongs to (`lib/navigation/activities.ts`, now the one source of the bar). A test fails when a route builder in `lib/navigation/routes.ts` is not listed, or an activity has no area, so the index cannot silently drift from the screens that exist.
4. **Agent rules, stated in the index:** use the normal UI and its validation; no direct database manipulation; no hidden runtime writes (Docker, containers, Modbus behind the UI); never force a physical output (ADR-0015); never invent vendor facts; ask the user before material engineering decisions and before anything that starts, stops or writes to a running plant; report what was done.
5. **Page-level LLM Context** (TASK-1002, TASK-1003) follows the same principle: one reusable structure, generated from the page's own data and services, with the same validation source as the human UI. The index's "LLM Context" column is driven by each area's flag and flips as those tasks land.

## Consequences
- An agent needs nothing but a browser or an HTTP client and the user's session; nothing is configured on the server for it.
- The index pages carry no factory data and need neither a database nor an owner, so they render even when the host is down.
- A new screen must be added to the registry, or the build's tests fail: the cost of keeping the index honest is one entry per screen.
- Agents that bypass the UI are outside the product's contract; the rules say so, and the application's existing boundaries (server-only Docker, validated services) are what enforce it.
