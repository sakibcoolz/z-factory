# TASK-209 — Reconcile Stored Runtime State With Docker After a Host Restart

Status: **TODO**
Linear: [ZFA-54](https://linear.app/recruit-verse/issue/ZFA-54)

## Finding (2026-10-07)
After the host rebooted, a factory was still stored as RUNNING (factory and PLC) while its container had exited. The Runtime screen showed RUNNING, and "Start factory" did nothing, until "Refresh state" on the PLC's own screen read the live state.

## Acceptance criteria
- "Start factory" (and the Runtime screen) read each PLC's live container state before deciding, so a PLC whose container has exited is started again.
- The Runtime screen does not present a stale RUNNING as current: it shows the live state, or marks the stored state as stored and unverified.
- Tests cover a stored RUNNING with an exited or missing container.
