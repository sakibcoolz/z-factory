# Linear Workflow

Linear is the execution tracker. Repository Markdown is the durable engineering specification.

## Mapping
- One Linear Project: Z-Factory.
- Each repository phase maps to a Linear milestone when supported.
- Each Markdown task maps 1:1 to a Linear issue.
- Task file stores `Linear: <identifier/url>` once created.

## Status mapping
- Planned -> Backlog
- Ready -> Todo
- In Progress -> In Progress
- Blocked -> blocked label + current workflow state
- Done -> Done

## Required Linear issue body
- repository task path;
- objective;
- scope;
- prerequisites;
- implementation notes;
- acceptance criteria;
- test requirements;
- documentation requirements;
- Graphify impact step.

## Sync rule
When status/scope changes, update both Linear and the Markdown task in the same work session.

## Current bootstrap note
The Linear workspace must provide the intended team for Z-Factory before issues are created. Do not place Z-Factory issues into an unrelated team merely to satisfy automation.
