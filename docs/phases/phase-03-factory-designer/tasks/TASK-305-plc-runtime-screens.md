# TASK-305 — Stored PLC Program, Versions, Runtime & Simulator Screens

Status: **PLANNED**
Linear: [ZFA-20](https://linear.app/recruit-verse/issue/ZFA-20)

Proposed while closing TASK-302 (2026-10-05). It stays PLANNED until the owner confirms it.

## Objective
Wire the PLC edit sections that TASK-302 lists but does not implement for stored PLCs: Program, Versions, Runtime and Simulator. Their services already exist (TASK-202, TASK-203, TASK-204).

## Scope
- Program: edit Structured Text, save a program version, show compile diagnostics.
- Versions: program versions and deployment snapshots, with which one is deployed.
- Runtime: start, deploy, stop, restart and remove the PLC runtime; show state and failures.
- Simulator: start and stop the factory's device simulation; device states; fault inject, clear and reset.

## Prerequisites
TASK-302.

## Out of scope
Live Tags and Events (TASK-401), Export (TASK-304).

## Acceptance
- A stored PLC can be programmed, started, deployed to and stopped from its screens.
- Compile and runtime failures are shown, not swallowed.
- The device simulation of a stored factory can be started and stopped and its device states seen.
- Long-running actions (image pull, compile) do not block the page without feedback.
- Docker details never reach the browser.
