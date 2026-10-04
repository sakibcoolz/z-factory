# TASK-701 — Boiler Module Definition & PLC I/O Profile

Status: **PLANNED**

## Goal
Define the boiler as a process module composed from generic catalog devices.

## Scope
- required/optional device roles
- logical PLC inputs/outputs
- default tag naming
- compatible signal types and engineering units
- required interlock metadata
- module configuration validation
- example non-vendor-specific boiler profile

## Initial logical signals
Inputs may include bottom/middle/top temperature, level, flow, pressure, heater status/fault and circulation-pump feedback.
Outputs may include heater enable/power, circulation-pump command, inlet/outlet valve commands and alarm reset as applicable to the configured module.

Exact signals are profile-driven; no vendor-specific I/O counts are invented.

## Acceptance
- Boiler module can be instantiated using existing DeviceInstances.
- Required roles/signals are validated before runtime start.
- PLC inputs/outputs are allocated through standard Z-Factory mapping rules.
- Boiler-specific metadata does not leak into generic DeviceModel records.
