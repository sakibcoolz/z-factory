# TASK-002 — Linear Project & Task Sync

Status: **DONE**
Linear: [ZFA-2](https://linear.app/recruit-verse/issue/ZFA-2)

## Objective
Create Z-Factory project in Linear and mirror all implementation task files as issues.

## Steps
1. Select intended Linear team.
2. Create project `Z-Factory`.
3. Create milestones for phases where appropriate.
4. Create 1:1 issues for each task Markdown.
5. Add repository task path to each issue.
6. Backfill Linear identifier/url into each task file.
7. Confirm status mapping.

## Acceptance
Every implementation task has exactly one Linear issue and no Z-Factory task is placed in an unrelated team.

## Evidence (2026-10-04)
- Team: `z-factory` (key ZFA), dedicated to this repository.
- Project: [Z-Factory](https://linear.app/recruit-verse/project/z-factory-80c595b696da), status In Progress.
- Milestones: one per phase (Phase 00 – Phase 05).
- Issues: ZFA-1 … ZFA-19, one per task file, each carrying the repository task path and the body sections required by `docs/linear-workflow.md`.
- Every task file stores its `Linear:` identifier and URL.
- Status mapping applied: Planned → Backlog, Ready → Todo, In Progress → In Progress, Done → Done. No task is currently Blocked, so no `blocked` label was needed.

| Task | Issue | Linear state |
|---|---|---|
| TASK-001 | ZFA-1 | Done |
| TASK-002 | ZFA-2 | Done |
| TASK-003 | ZFA-3 | Todo |
| TASK-101 | ZFA-4 | In Progress |
| TASK-102 | ZFA-5 | Backlog |
| TASK-103 | ZFA-6 | Backlog |
| TASK-104 | ZFA-7 | In Progress |
| TASK-201 | ZFA-8 | Backlog |
| TASK-202 | ZFA-9 | Backlog |
| TASK-203 | ZFA-10 | Backlog |
| TASK-204 | ZFA-11 | Backlog |
| TASK-301 | ZFA-12 | Backlog |
| TASK-302 | ZFA-13 | Backlog |
| TASK-303 | ZFA-14 | Backlog |
| TASK-304 | ZFA-15 | Backlog |
| TASK-401 | ZFA-16 | Backlog |
| TASK-402 | ZFA-17 | Backlog |
| TASK-501 | ZFA-18 | Backlog |
| TASK-502 | ZFA-19 | Backlog |
