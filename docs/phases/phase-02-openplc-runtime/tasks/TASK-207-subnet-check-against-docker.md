# TASK-207 — Check a Factory's Subnet Against Existing Docker Networks

Status: **TODO**
Linear: [ZFA-52](https://linear.app/recruit-verse/issue/ZFA-52)

## Finding (2026-10-07)
A pump station demo factory was given 172.20.1.0/24, free in the database but held by an orphan Docker network (TASK-206). "Start factory" then faulted its PLC with "This subnet overlaps a network that already exists on the Docker host". Creating or editing a factory (and the demo's choice of subnet) checks only the factories in the database.

## Acceptance criteria
- Creating or editing a factory refuses a subnet that overlaps an existing Docker network, saying so, before anything is started.
- The demo factory picks a subnet that is free both in the database and on the Docker host.
- When Docker cannot be reached, the check says so instead of passing silently.
- Tests cover a subnet that is free in the database but taken in Docker.
