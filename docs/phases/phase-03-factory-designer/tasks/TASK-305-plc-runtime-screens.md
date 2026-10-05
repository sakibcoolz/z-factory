# TASK-305 — Stored PLC Program, Versions, Runtime & Simulator Screens

Status: **DONE**
Linear: [ZFA-20](https://linear.app/recruit-verse/issue/ZFA-20)

Proposed while closing TASK-302 (2026-10-05); confirmed by the owner and started on 2026-10-05.

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

## Evidence (2026-10-05)
- **Programmed, started, deployed to and stopped from its screens.** In a browser against a production build: a PLC created from the catalog (CPU 1214C) with a valve and a transmitter opened with a starter program declaring its four tags; the program was checked, saved as version 1, the runtime started from the Runtime screen (running after 8 s with a cached image), a change saved and deployed from the editor, an earlier version deployed from Versions, and the runtime stopped and removed. The same sequence runs through the server actions against a real OpenPLC container in `test/integration/plc-runtime-screens-docker.test.ts`.
- **Compile and runtime failures are shown.** A program that does not compile lists its findings with line and column, and choosing one moves the cursor there. A failed deploy is visible three ways: the message under the button, the version marked failed, and a `PLC_PROGRAM_DEPLOY_FAILED` line in the PLC's runtime events. An unreachable Docker Engine answers "The Docker Engine is not reachable.", marks the PLC faulted and records a critical event (tested without an engine).
- **Simulation started, stopped and seen.** On the Simulator screen the valve was seen cycling under PLC control (open command on, position rising to 100 %, limit switch reported, command dropped, position falling), a stuck fault froze it and clearing the fault released it. Tested against an in-process Modbus server and against the real runtime.
- **Long-running actions give feedback.** While an operation runs its button names it and counts seconds, the other buttons are disabled and a line explains the wait; the Runtime and Simulator pages re-read themselves (5 s and 2 s). Component tests cover the pending state.
- **Docker details never reach the browser.** The rendered Runtime page of a running PLC contained neither the container id (full or short), nor the management port, nor a socket path. The read models are checked for the same in tests, with a real container id.
- Tests added: 10 unit, 12 component, 10 read-model and 9 action tests against PostgreSQL, and 5 on a real OpenPLC runtime. 536 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.

## Defects found and fixed while wiring the screens
- **A start whose program does not compile left the PLC on STARTING for good.** The state the runtime reports is now stored (degraded: container up, no program).
- **A deliberately stopped PLC read back as FAULTED.** The stopped container ends with the stop signal's exit code; a runtime Z-Factory stopped now stays STOPPED when its state is read.
- **A failed "save & deploy" left the failed version selected**, so the next start would have tried it again. The previously selected version is selected again.
- **A confirmed operation ran on the first press** (found in the browser, before any commit): the confirmation button now asks first and submits only on the second press.

## Decisions made in this task
- **Operations are awaited, not queued.** An action answers when its operation has finished, so compile findings and failures come straight back. The state is stored at every step, so a reloaded page still shows where a start is.
- **The Runtime page reads the live state when it is opened** and stores it as the last known state, except while a start or stop is in progress. Other screens show the stored state.
- **The simulator screen is factory-wide**, as in the wireframe; a PLC's section list links to it.
- **A factory Runtime screen** lists the PLCs with their stored state and links to each PLC's Runtime screen. It was not in the scope list; it is what the Simulator's "Runtime" tab and the factory overview link to.
- **Starter program.** A PLC without a program opens with one generated from its tags, so the addresses the simulator uses do not have to be typed by hand.

## Not in this task
- "Start factory" (all PLCs and the simulation in one action).
- Forcing sensor and switch values from the screen; the service exists.
- Changing a PLC's Modbus endpoint from the screen; the service exists.
- Live values without polling, Live Tags, Events and Logs for stored factories (TASK-401).
- Syntax highlighting, several program files per PLC, container logs and CPU/memory figures.
- Restoring a simulation after a server restart: it has to be started again, and stored device states are stale until then.
