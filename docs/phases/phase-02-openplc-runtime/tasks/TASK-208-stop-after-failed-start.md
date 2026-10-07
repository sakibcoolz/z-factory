# TASK-208 — "Stop Factory" Must Leave a Factory Stopped After a Failed Start

Status: **TODO**
Linear: [ZFA-53](https://linear.app/recruit-verse/issue/ZFA-53)

## Finding (2026-10-07)
After a start that failed before any container existed, the factory stayed DEGRADED with its PLC FAULTED.
- "Stop factory" answered that the simulation and every PLC runtime were stopped, but the stored states did not change.
- Editing and deleting, which need a stopped factory, were refused.
- Only "Refresh state" on the PLC's own Runtime screen reconciled it.

## Acceptance criteria
- "Stop factory" reconciles every PLC with its real container state (absent, exited or running), so a factory with nothing running ends STOPPED.
- What it reports matches the stored state afterwards.
- A factory whose start failed can then be edited and deleted without a per-PLC workaround.
- Tests cover a failed start (no container) followed by stop, edit and delete.
