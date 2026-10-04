# TASK-704 — Boiler UI, Scenarios & Engineering Export

Status: **PLANNED**

## Goal
Expose the boiler module clearly in the factory UI without turning boiler-specific UX into generic device screens.

## Scope
- boiler module overview
- assigned devices and PLC I/O map
- bottom/middle/top temperatures
- target temperature and PLC command/status values
- trend/scenario view
- fault injection/reset controls under existing authorization/audit rules
- module configuration/scenario export
- documentation and demo scenario

## Acceptance
- UI distinguishes setpoint/command values from actual feedback.
- User can trace each boiler logical signal to its device and PLC tag/I/O mapping.
- Export includes module configuration, assigned devices, I/O/tag map, model parameters/version and simulation disclaimer.
- Demo shows start, heat-up, target-band control, optional hold and defined fault case.
