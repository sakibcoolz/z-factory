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

## Implementation (TASK-202, ADR-0009)
Runtime: the official OpenPLC Runtime v4 image, pinned by digest. Code: `lib/runtimes/openplc/` (adapter), `lib/protocols/modbus/` (client), `lib/services/plc-runtime-service.ts` (lifecycle with persistence).

### Deployment chain
```text
ProgramVersion (ST source, immutable, checksum)
 -> STruC++ compile in a separate process        (diagnostics with line/column on failure)
 -> bundle: generated sources + debug tables + runtime headers + defines.h + conf/modbus_slave.json
 -> upload through the runtime REST API           (no mounts, no exec)
 -> runtime builds a shared library and reloads   (container and image untouched)
 -> program RUNNING, Modbus TCP server on :502
```

### Lifecycle (service functions)
| Function | Effect |
|---|---|
| `createProgramVersion` | saves version n+1 with its SHA-256 checksum as `DRAFT` and selects it |
| `startPlc` | ensures the factory network, creates the container from the allow-listed image (two loopback host ports: API and Modbus), waits for the API, creates the API user, deploys the selected version |
| `deployProgramVersion` | compiles, uploads and runs a version in the existing container; marks it `DEPLOYED`, the previous one `COMPILED`; records a `ConfigurationVersion` snapshot and `PLC_PROGRAM_DEPLOYED` |
| `refreshPlcState` | reads container and program state and stores it as the last known state |
| `restartPlc` | restarts the container; the runtime reloads and runs the program it had |
| `stopPlc` / `removePlcRuntime` | stops the container / removes it and releases its management port; program versions and the Modbus endpoint are kept |
| `configureModbusEndpoint` | sets the host address and port the Modbus server is published on; only while no container exists |
| `readPlcRegisters` / `writePlcRegister` | raw Modbus access to the running program; typed, permission-checked access is in the tag service (`docs/gateway-modbus.md`) |

Every function takes the `Actor` and treats a PLC of another owner as not found.

### What is recorded
- `ProgramVersion`: `version`, `sourceText`, `checksum`, `status` (`DRAFT` → `DEPLOYED` / `FAILED`; a superseded deployment becomes `COMPILED`), `compiledArtifactRef` (`md5:<program md5>`).
- `PlcInstanceProfile`: `runtimeImage` (reference with digest), `imageDigest` (image id that ran), `runtimeVersion` (`OpenPLC Runtime v4.2.4`), `apiHostPort`, selected `programVersionId`.
- `RuntimePort`: the Modbus TCP port (container 502 → loopback host port).
- `DeviceInstance`: `dockerContainerId` (server-side only), `hostName` (DNS name in the factory network, derived from the instance name), last known `runtimeStatus`.
- `ConfigurationVersion` (scope `PLC`), one per deployment: program version, checksum and MD5, compiler version, I/O and Modbus mapping versions, runtime, image and digest.

### Failures
- A program that does not compile never reaches the runtime: the version becomes `FAILED`, `PLC_PROGRAM_DEPLOY_FAILED` (warning) is recorded, and the PLC keeps running the previous program.
- A runtime build or start failure marks the version `FAILED`, records `PLC_PROGRAM_DEPLOY_FAILED` (critical) and re-reads the runtime state.
- A failed start, stop or remove, or a container that died, makes the device `FAULTED` with a `DEVICE_FAULTED` event.
- State mapping: container running + program `RUNNING` → `RUNNING`; running with no or a stopped program → `DEGRADED`; program `ERROR` or a non-zero container exit → `FAULTED`.

### Identity
The hardware profile (manufacturer, family, model) stays on the catalog model of the device instance. The runtime identity is recorded separately as `OpenPLC Runtime <version>` plus the image digest. Nothing claims vendor firmware, vendor timing or real-time behavior: in the container the runtime uses default scheduling.

### Not yet wired
No screen calls these services yet; the Program, PLC overview and Runtime screens still render fixtures. The tag registry and its Modbus map exist (TASK-203); generating tags and I/O points from the PLC configuration form is TASK-302.
