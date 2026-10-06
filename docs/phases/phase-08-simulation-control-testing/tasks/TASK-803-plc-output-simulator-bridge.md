# TASK-803 — PLC Output → Simulator Command Bridge

Status: **DONE**
Linear: [ZFA-41](https://linear.app/recruit-verse/issue/ZFA-41)

## Goal
Make PLC-program-generated outputs drive the correct simulated actuator/device commands while preserving the PLC as control authority.

## Required flow

```text
PLC program
 -> program-driven output/tag
 -> process/device bridge
 -> simulated device command
 -> Go behavior/physics model
 -> actual feedback/process value
 -> bridge
 -> PLC input/feedback tag
```

Examples:
- PLC `RUN` output -> VFD simulator run command.
- PLC speed/frequency output -> VFD simulator setpoint.
- VFD simulator -> actual frequency/current/torque.
- Motor simulator -> actual RPM/current/temperature.
- Pump/process model -> pressure/flow.
- PLC valve command -> simulated valve movement -> actual position/end-switch feedback.

## Rules
- Command/setpoint and actual feedback remain separate.
- Bridge reads program-generated outputs; UI does not manufacture those outputs.
- Simulated actuator response can be dynamic (ramp, delay, inertia, limits, faults), not instantaneous unless the model says so.
- The bridge must preserve quality/stale/disconnected semantics.
- Do not reinterpret a raw Modbus write to a local output as the normal control flow; follow ADR-0015.

## Acceptance criteria
- A PLC output change reaches the intended simulated actuator.
- Simulator behavior changes over time according to the device/process model.
- Feedback returns to mapped PLC inputs/tags.
- Loss/staleness produces explicit quality rather than false healthy state.
- Closed-loop tests verify at least VFD/motor/process and valve-style command/feedback paths.

## As built
The control path already ran through two bridges: the device simulator's PLC bridge (TASK-204: VFD, motor, pump, valve, sensors) and the process bridge to the Go service (TASK-603). TASK-803 makes the command/feedback split explicit in the tag model and makes loss visible instead of letting held values look healthy. Design notes: `docs/device-simulation.md` → Command bridge.

- **Command apart from feedback.** `tagAuthority` classifies a tag carrying a device command (`run`, `frequencySetpoint`, `open`, `positionSetpoint`, …) or a process module's OUTPUT as `PROGRAM_OUTPUT` wherever it sits, `%M` included. Before, a device command on `%M` was shown as "simulated feedback". Feedback (a device's output signal, a module's INPUT/ALARM) stays `SIMULATION_FEEDBACK`. A signal key flows the same way in every device type (`deviceSignalDirection`, checked by a test). Nothing changes about who may write: neither kind is writable from outside.
- **Release on stop.** `PlcBridge.release` writes every feedback tag de-energized (false / 0, or the bottom of a range that excludes 0) when the device simulation or the process bridge stops, as the wiring of powered-down equipment reads. The PLC's commands are never written. The program sees running and limit-switch signals drop instead of running on the last values.
- **Feedback quality.** The tag monitor asks the writer of each feedback tag how it is doing (`writerQuality`, once per writer and cycle). A good read takes the writer's quality: `STALE` while no simulation of the device runs or the module's bridge is stopped or cannot advance the model; `DISCONNECTED` while the bridge cannot reach the PLC; `BAD` while a simulated sensor has lost its signal. A change of quality alone is published to the stream and sampled into telemetry. Code: `feedbackQuality` in `lib/domain/live.ts`, `feedbackQuality` on `DeviceSimulatorRuntime` and `ProcessBridgeRuntime`, and `feedbackWriter` in `lib/services/live-service.ts`.
- **Dynamic response** stays the models': the drive ramps, the motor follows, the valve travels its stroke and switches its limit at the end, and a stuck valve stays put.

No schema change, no new route. The Live Tags screen shows the new authority and quality without UI code changes.

## Evidence
- Unit tests:
  - `lib/domain/tag-authority.test.ts`: commands on `%M` and `%Q`, module OUTPUT, feedback, and the signal-direction consistency check.
  - `lib/runtimes/tag-monitor/monitor.test.ts`: the worse-of rule; writer quality degrading and recovering; once per writer; a quality-only change published.
  - `lib/runtimes/device-sim/runtime.test.ts`: GOOD → DISCONNECTED → GOOD; release on stop; STALE after stop; BAD for a sensor with `BAD_QUALITY`.
  - `lib/runtimes/process-bridge/runtime.test.ts`: STALE and DISCONNECTED from the module; release on stop without touching the commands.
- Integration test `test/integration/command-bridge.test.ts` (Docker, real OpenPLC; passed 3 times in a row and in the full suite). The program opens a valve on request and runs a drive only once the valve's open limit switch proves it open. It shows:
  - authorities on the Live Tags screen;
  - feedback `STALE` before the simulation starts;
  - the valve travelling over its stroke while the program holds the drive and raises its interlock;
  - the drive running once the valve is open, frequency command 30 Hz while the actual frequency ramps;
  - program-driven tags refused to writers;
  - a stuck valve staying open when commanded closed;
  - on simulation stop: feedback released, the program withdrawing the drive, the screen and telemetry showing `STALE`;
  - the loop closing again on restart.
- Full suite with `TEST_DOCKER=1` and `PROCESS_SIM_BIN`: 94 files, 1022 tests passed. Two test-timing races were found on the way and fixed in the tests only:
  - the new stuck-valve step now injects the fault before the command changes;
  - `process-bridge-runtime.test.ts` (TASK-603) now waits for the alarm-clear record, which the bridge writes after the PLC within the same cycle.
- prettier, lint, `tsc --noEmit` and `next build` are clean.
- Browser (headless Chromium against `next start`, temporary factory "ZZ Command Bridge Check" with a catalog PLC, valve and VFD, removed afterwards):
  1. *Start factory* runs the PLC and the simulation. A start request puts the valve mid-stroke (24 %) with the interlock on and the drive held.
  2. Live Tags shows all 10 tags GOOD, with `VFD01_Run` on `%MX31.0` labelled "program output".
  3. *Stop simulation* releases the feedback (position 0 %, open limit off, actual 0 Hz). The program withdraws the drive and raises its interlock.
  4. Live Tags then shows the 4 feedback tags `STALE` and the 6 commands and program outputs `GOOD`.

## Limits
- A held feedback tag shows when its writer last refreshed it: the "updated" time of a STALE value keeps ageing although the PLC still answers.
- With the bridge stopped, the program sees de-energized feedback, not a separate quality bit. A program that must tell "equipment off" from "simulation gone" needs a status signal that is true while healthy (a ready or running bit).
