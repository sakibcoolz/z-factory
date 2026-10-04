# TASK-202 — OpenPLC Runtime Adapter

Status: **PLANNED**
Linear: pending

## Objective
Implement the OpenPLC runtime adapter using reusable image + generated configuration/program artifacts.

## Required behavior
Create, start, stop, restart, remove, inspect, health-check, and capture runtime metadata.

## Acceptance criteria
- Program deployment/version is explicit.
- I/O mapping version is recorded.
- Runtime failures become domain states/events.
- No claim of exact vendor firmware/timing.
- Integration test demonstrates OpenPLC startup and health.
