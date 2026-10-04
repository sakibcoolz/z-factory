# TASK-202 — OpenPLC Runtime Adapter

Status: **READY**
Linear: [ZFA-9](https://linear.app/recruit-verse/issue/ZFA-9)

## Objective
Implement the OpenPLC runtime adapter using a reusable versioned image plus generated PLC-specific configuration, program, I/O/tag and Modbus mapping artifacts.

## Required behavior
Create, configure, attach network, start, stop, restart, remove, inspect, health-check, deploy/reload program, read/write tags, and capture runtime metadata.

## Acceptance criteria
- Program deployment/version is explicit.
- Program edits can redeploy/reload without rebuilding the base image.
- I/O/tag/Modbus mapping versions are recorded.
- Runtime failures become domain states/events.
- PLC hardware profile remains distinct from OpenPLC runtime identity.
- No claim of exact vendor firmware/timing.
- Integration test demonstrates OpenPLC startup, program execution, health and tag access.
