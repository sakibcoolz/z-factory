# TASK-702 — Multi-Zone Boiler Thermal Model

Status: **PLANNED**

## Goal
Implement a deterministic, explicitly approximate boiler-water thermal model in the Go simulation service.

## Scope
- bottom/middle/top water zones
- configurable water mass/volume
- initial and ambient temperatures
- heater power/output percentage
- inter-zone heat transfer coefficients
- environmental heat-loss coefficients
- optional circulation/mixing effect
- sensor sampling/quality model
- deterministic time-step update
- parameter validation and tests

## Model principle
Each tick updates energy input, inter-zone transfer and environmental loss. Heating duration emerges from model parameters and elapsed simulation time; it is not hard-coded.

A process recipe may separately request a hold duration after the PLC reaches the target band.

## Fidelity
The model is for software/control-loop testing. It must not claim thermodynamic design accuracy, pressure-vessel validation or safety certification.

## Acceptance
- Starting from a fixed state and command sequence produces repeatable temperature trajectories.
- Bottom/middle/top zones may differ and converge according to configured transfer/mixing.
- Heater power, water volume and heat-loss changes measurably affect warm-up time.
- Tests cover energy balance sanity, bounds and deterministic stepping.
