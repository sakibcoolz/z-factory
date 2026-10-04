# Graphify Workflow

Graphify is the code/document knowledge-graph reference layer for AI coding agents.

## Setup
Install the official `graphifyy` CLI, register the project skill for the agent(s), and generate the graph from the repository.

Expected generated output:
```text
graphify-out/
  graph.html
  GRAPH_REPORT.md
  graph.json
```

## Agent workflow
Before broad cross-module work:
1. Ensure graph is current.
2. Query Graphify for the impacted domain/path.
3. Read authoritative docs/task files.
4. Implement.
5. Refresh/update graph after structural changes.
6. Review graph impact before declaring the task Done.

## Authority
Graphify is a navigation and impact-analysis aid. It never overrides `AGENTS.md`, architecture/rules/database docs, or the active task.

## Repository policy
Generated graph artifacts may be ignored if too large/noisy; the team may commit `GRAPH_REPORT.md` selectively. Do not make completion depend on a machine-specific path.
