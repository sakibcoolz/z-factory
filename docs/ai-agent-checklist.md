# AI Coding Agent Checklist

## Before work
- [ ] Read `AGENTS.md` and every mandatory doc.
- [ ] Open active phase README and task Markdown.
- [ ] Confirm task is READY/IN PROGRESS and prerequisites are satisfied.
- [ ] Read linked Linear issue.
- [ ] Query Graphify for impacted code once graph exists.
- [ ] Identify catalog-model vs factory-instance impact.
- [ ] Identify compact vs modular PLC impact.
- [ ] Identify runtime-live-state vs persistence impact.
- [ ] Identify Modbus command/setpoint vs feedback mapping impact.

## During work
- [ ] Stay inside task scope.
- [ ] Preserve PLC-as-control-authority rule.
- [ ] Keep Docker/server-only code out of the client bundle.
- [ ] Prevent duplicate/invalid I/O assignments.
- [ ] Do not invent vendor facts/register maps.
- [ ] Use reusable runtime images and shared device simulator patterns.
- [ ] Add unit/integration tests.
- [ ] Update docs when contracts change.

## Before Done
- [ ] Lint/typecheck/tests pass.
- [ ] Acceptance criteria demonstrated.
- [ ] Live-state persistence rules are respected.
- [ ] PLC export remains consistent with schema/mappings if affected.
- [ ] Task Markdown includes evidence/status.
- [ ] Linear issue updated.
- [ ] Graphify refreshed for structural changes.
- [ ] No secrets/generated junk committed.
