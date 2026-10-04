# OpenPLC Runtime

## Role
OpenPLC is the first executable PLC runtime in Z-Factory.

## Principle
The selected PLC hardware profile and the executable runtime are separate. A Siemens/Rockwell/Schneider profile may be represented by an OpenPLC-backed virtual PLC, but Z-Factory must never claim that OpenPLC is the vendor firmware/controller runtime.

## PLC identity
Primary PLC identity is manufacturer + family + exact model. Process role is separate metadata.

Example:
```text
Device: S7-1200-1214C-01
Profile: Siemens SIMATIC S7-1200 CPU 1214C
Runtime: OpenPLC
Role: Pump Station Controller
Protocol: Modbus TCP
```

## Program lifecycle
Initial text representation prioritizes IEC 61131-3 Structured Text. Ladder editing may follow.

Required workflow:
`edit -> save version -> validate/compile -> deploy -> run/stop/restart -> debug/watch -> rollback`.

The PLC container executes the program continuously. Editing the program should update/reload runtime artifacts; it should not rebuild the Docker image unless the base runtime changes.

## I/O and tags
Z-Factory maps:
`catalog channel -> PLC logical address -> symbolic tag -> protocol area/address`.

Every virtual PLC has a generated tag registry. Tag metadata includes data type, direction, role, logical I/O address, Modbus address, access, scale/unit, source device/channel, quality and timestamp metadata.

## Command vs feedback
External clients write command/setpoint tags. PLC logic produces/consumes device commands and feedback.

Examples:
- `Pump01_StartCommand` -> command coil
- `VFD01_FrequencySetpoint` -> writable holding register
- `VFD01_ActualFrequency` -> feedback register
- `Motor01_ActualRPM` -> feedback register
- `Pump01_Fault` -> status/alarm

## Container lifecycle
Create -> configure -> attach network -> start -> health check -> deploy/reload program -> running -> stop/restart/remove.

## Required runtime metadata
Runtime version, image digest/tag, program version, I/O mapping version, Modbus mapping version, container/network IDs, protocol ports, health/runtime state.

## MVP boundary
Do not claim exact hardware timing, electrical behavior, proprietary backplanes, vendor engineering-suite compatibility, or safety certification.
