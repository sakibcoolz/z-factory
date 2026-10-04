# TASK-201 — Docker Engine Integration

Status: **PLANNED**
Linear: [ZFA-8](https://linear.app/recruit-verse/issue/ZFA-8)

## Objective
Implement server-only Docker Engine integration and safe factory network/container lifecycle.

## Acceptance criteria
- Docker code cannot be imported by client components.
- Image allow-list.
- Safe network/subnet creation.
- Port conflict validation.
- CPU/memory limits.
- No arbitrary host volume/privileged/command injection.
- Lifecycle integration tests.
