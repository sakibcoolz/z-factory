# TASK-804 — Closed-Loop Test Scenarios, Events & E2E Validation

Status: **DONE**
Linear: [ZFA-42](https://linear.app/recruit-verse/issue/ZFA-42)

## Goal
Provide repeatable industrial simulation tests that prove PLC logic reacts correctly to controlled process conditions.

## Scenario examples
### High-temperature alarm
1. Start in AUTO below threshold.
2. Apply temperature MANUAL_OVERRIDE above the configured PLC threshold.
3. Confirm PLC program raises the alarm/output.
4. Confirm any configured actuator command follows PLC logic.
5. Clear override.
6. Confirm process/input returns to AUTO and PLC state recovers according to its program.

### VFD / motor closed loop
1. PLC issues run + speed/frequency command.
2. Simulator ramps VFD/motor actual values.
3. Process feedback changes.
4. PLC reads feedback and continues/rejects control according to its logic.

## Event/audit requirements
Record meaningful runtime events for:
- override set
- override changed
- override cleared
- scenario started/completed/failed
- validation rejection
- simulator disconnected/stale

Do not persist every simulation tick as an event.

## Acceptance criteria
- E2E automated test proves input override -> PLC logic -> output -> simulated device/process -> feedback -> PLC.
- Test verifies alarm threshold behavior without directly setting the alarm output.
- Scenario can be repeated deterministically.
- Runtime evidence identifies which values were manually overridden.
- Clearing all overrides restores AUTO mode.

## As built
- **Scenarios.** A scenario is a JSON test of the PLC program against the simulated plant (`lib/domain/scenario.ts`, `lib/validation/scenario.ts`, `lib/services/scenario-service.ts`; design in `docs/process-simulation.md` → Scenarios).
  - Steps:
    - `WRITE` a command or setpoint tag;
    - `FORCE` a simulated sensor or switch;
    - `OVERRIDE` or `RAMP` a process module's measured value;
    - `CLEAR` everything back to AUTO;
    - `EXPECT` a PLC tag (EQ, NE, GT, GTE, LT, LTE, tolerance, within a time, optionally held);
    - `WAIT`.
  - Anything the program decides can only be expected: a WRITE to an alarm, an output or feedback refuses the run before anything happens.
  - A run starts only from AUTO and ends with every value back in AUTO, pass or fail.
  - The report gives, per step: the result, the value read and the time. It also lists every value that was out of AUTO.
  - Limits: 100 steps, 300 s per step, 900 s per scenario. One run per factory at a time.
- **Events.**
  - `SCENARIO_STARTED`, `SCENARIO_COMPLETED`, `SCENARIO_FAILED` and `SCENARIO_REJECTED`, in a new SCENARIO family on the Events screen.
  - `PROCESS_OVERRIDE_CHANGED` (with `from`) and `PROCESS_OVERRIDE_REJECTED` (with `rule`).
  - A no-op clear records nothing.
  - An override set by a run carries its `scenario` and `runId`.
  - Simulator disconnection and staleness were already recorded (`PROCESS_QUALITY_CHANGED`, `CONNECTION_DOWN`, TASK-803 feedback quality). Ticks are never events.
- **Clear all.** `clearAllOverrides` releases every forced device value and process override of a factory; `listActiveOverrides` lists them (`FactorySimulation.forced()` is new).
- **Screen.** `/factories/[factoryId]/scenarios`, a tab next to Simulator, has:
  - the values out of AUTO, with *Clear all overrides*;
  - a JSON editor prefilled with an example for the factory's own PLC and tags;
  - *Run scenario*, with the report;
  - the recorded runs.
- The task's high-*temperature* example is realised with a temperature transmitter of the device simulator (forced), because no Go model has a temperature. The Go path is covered by the discharge-pressure scenario.

## Evidence
- Unit tests:
  - `lib/domain/scenario.test.ts`: comparisons, labels, time bound, schema;
  - `lib/events/events.test.ts`: the families, including SCENARIO.
- `test/integration/closed-loop-scenarios.test.ts` (Docker, real OpenPLC; passed 3 times in a row and in the full suite):
  - Scenarios writing the alarm or the drive command, or naming an unknown device, are refused, recorded, and nothing reaches the PLC.
  - **High temperature, run twice with the same outcome.**
    1. TT-01 is forced from 55 to 92 °C.
    2. The program raises `High_Temp_Alarm`, withdraws `VFD_Run`, the drive ramps to 0, the pump stops, and the program sets `Stopped_On_Alarm` from that feedback.
    3. After CLEAR the temperature is back to 55 °C, and the alarm stays latched until a reset below 75 °C.
    4. The drive runs again.
    5. Only `Start_Cmd`, `Speed_SP` and `Reset_Cmd` were written. TT-01 is named in the report and in `SCENARIO_COMPLETED`.
  - **VFD, motor and process, run twice alike.** The program limits 50 Hz to 45 Hz, the pressure rises with speed², and the program trips at 3 bar on its own feedback and stops the drive.
  - An unmet expectation fails the run with the reason, skips the rest, and leaves AUTO.
  - A run refuses to start while a value is forced; *clear all* releases it.
- `test/integration/process-bridge-runtime.test.ts` (Go service + OpenPLC): the discharge-pressure scenario, run twice alike.
  - It overrides 3.5 and then 3.8 bar. The program trips, the model's pump stops, and the alarm is latched after CLEAR until reset. The pressure then returns.
  - Events for the run: STARTED, SET, CHANGED (from 3.5), CLEARED, COMPLETED.
  - A refused override of `DUTY_RUN_CMD` fails the run and records `PROCESS_OVERRIDE_REJECTED`.
- Full suite with `TEST_DOCKER=1` and `PROCESS_SIM_BIN`: 96 files, 1031 tests passed. prettier, lint, `tsc --noEmit` and `next build` are clean.
- Browser (headless Chromium against `next start`, temporary factory "ZZ Scenario Check" with catalog models, removed afterwards):
  1. *Start factory* from the Runtime screen; the Scenarios tab shows everything in AUTO.
  2. The high-temperature scenario, run twice from the screen: PASSED 16/16 both times, TT-01 named as forced and back in AUTO, two recorded runs.
  3. A scenario writing `High_Temp_Alarm` is refused inline and listed as refused.
  4. The example is prefilled with `Start_Cmd` → `VFD_Run`.

## Limits
- Scenarios are pasted JSON. They are not stored as named definitions; the recorded runs are the history.
- A run is a server action that lasts as long as its steps (at most 900 s). Leaving the page does not stop it, and the run is still recorded.
- FORCE does not carry the run id on the device's `SIMULATED_INPUT_FORCED` event. The run's `SCENARIO_COMPLETED`/`FAILED` lists the forced devices.
