# TASK-804 — Closed-Loop Test Scenarios, Events & E2E Validation

Status: **PLANNED**
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
