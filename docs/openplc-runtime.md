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

## PLC scan-cycle and physical I/O authority
The PLC program is authoritative for local outputs (ADR-0015).

In simulation, Modbus may be used internally as a bridge to inject simulated input/process values and to observe program-generated outputs. This does **not** mean Modbus owns the PLC's output pins.

```text
simulation/process input
 -> simulation bridge
 -> PLC input image / simulation input memory
 -> PLC scan-cycle program
 -> PLC output image
 -> simulated actuator/device
```

For a physical target, the target adapter maps logical I/O to the real CPU/rack/module/channel. The PLC scan cycle then reads real inputs and writes real outputs locally. Modbus is only involved when the real topology intentionally uses Modbus remote I/O, a Modbus field device, PLC-to-PLC communication, or an external gateway.

REST runtime API is management-plane only: program upload/deploy, start/stop, status and logs. It is not the field-I/O control plane.

Normal UI/gateway control must target command/setpoint tags and let PLC logic decide the final local output. Direct output forcing is a separate diagnostic concept and is not part of the normal control path.

### As built (TASK-205)
Every tag has one owner, computed by `tagAuthority` in `lib/domain/tag-authority.ts` and shown as "driven by" on the Live Tags screen, in the Modbus map (`authority`) and in the engineering export:

| Authority | What it is | Who writes it |
|---|---|---|
| `PROGRAM_OUTPUT` | a tag on a DO/AO point (`%QX`/`%QW` channel), or any other `%Q` address that is not external command memory | the scan cycle only |
| `PROGRAM_INPUT` | a tag on a DI/AI point (the `%MX`/`%MW` shadow of the channel), or a `%I` address | the field; in simulation the device simulator, through the bridge |
| `SIMULATION_FEEDBACK` | `%M` memory a device signal or a process-module signal is delivered to | the device-simulator or process bridge |
| `LINK_INPUT` | `%M` memory a READ mapping of a PLC link fills (TASK-702) | the PLC link, with a peer PLC's value |
| `EXTERNAL_COMMAND` | a writable `COMMAND` or `SETPOINT` tag (`%Q` or `%M` memory that is not a channel) | a gateway or the UI; the program decides what follows |
| `PROGRAM_INTERNAL` | everything else | the program |

Enforced at every door:
- **Tag service.** `writeTag` (UI, gateway, system) accepts external command memory only; anything else is refused with `tag-read-only` and recorded as `COMMAND_REJECTED`. A `COMMAND`/`SETPOINT` tag cannot be created at an I/O point's address (`io-point-address`) and a tag bound to an I/O point cannot be writable (`io-point-read-only`); the database repeats the latter as `Tag_io_point_read_only_check` (migration `io_point_tags_read_only`).
- **Gateway.** A mapping may grant writing only on external command memory (`gateway-write-command-only`); "Map all tags" maps everything else for reading.
- **Raw register access.** `writePlcRegister` writes only an address that belongs to external command memory; a program output, an input, simulated feedback, program memory or an address without a tag is refused with `program-authority`, naming the owner. Reading stays unrestricted: outputs are observed, never driven.
- **Simulation bridges.** The device simulator reads what the program drives from `%Q`/`%M` and delivers feedback to `%M` only (`signal-address`); the process bridge follows the same rule (`docs/process-simulation.md` → Bridge). Neither writes a `%Q` address.
- **Runtime REST API.** Used for program upload, start, stop, status and logs only (`lib/runtimes/openplc/adapter.ts`); no field value travels over it.

Direct output forcing (writing a `PROGRAM_OUTPUT` for a test) has no entry point; Phase 08 defines simulation-side overrides instead.

### Physical target adapter (contract)
The same logical program, tags and canonical wiring are meant to run on a physical controller. What changes is an adapter, not the model:

| Concern | Z-Factory (logical, kept) | Target adapter (physical, per target) |
|---|---|---|
| Program | the Structured Text program version and its located variables | compiled and deployed with the vendor toolchain or an OpenPLC runtime on the hardware |
| I/O points | `PlcIoPoint` with its logical address (`%QX0.0`, `%MX0.0`, …) and the device terminal wired to it (ADR-0014) | the real module/channel the point maps to (`vendorAddress` from the catalog channel, slot and terminal); the runtime's own I/O driver reads inputs and writes outputs locally |
| Local outputs | `PROGRAM_OUTPUT` tags: never written from outside | driven by the scan cycle through the output module; nothing on the network writes them |
| Inputs | `PROGRAM_INPUT` tags: fed by the field or the simulation bridge | fed by the input module; the simulation bridge does not exist on the target |
| External commands | `EXTERNAL_COMMAND` tags on a Modbus TCP server endpoint | the same tags on the controller's Modbus TCP server (or the protocol the plant uses) |
| Feedback to the outside | `SIMULATION_FEEDBACK` and program memory read over Modbus | the controller's own values read over Modbus; no simulator fills them |
| Remote I/O and field buses | modeled as devices with ports and protocol links | Modbus (or another field bus) exactly where the plant topology has it |

An adapter therefore needs: the program version, the I/O point → physical channel map, the Modbus map (areas, addresses, access modes, scaling) and the device schedule — all of which the engineering export already carries. The adapter itself (vendor project generation, download, commissioning) is a later task; nothing in the current model has to change for it, and `Z-Factory never requires Modbus for a controller's local I/O`.

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
| `checkProgram` | compiles a source without saving or deploying it; returns errors and warnings with line and column |
| `selectProgramVersion` | selects an existing version for the next start or deploy |
| `saveAndDeployProgram` | saves the source as a new version and deploys it; source identical to the selected version is deployed without a new version; needs a started runtime |
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
- A program saved and deployed in one step that fails stays stored as `FAILED`, and the previously selected version is selected again, so the next start does not pick the failed one.
- A start whose selected program fails leaves the container up without that program: the state the runtime reports is stored (`DEGRADED`), never `STARTING`.
- A failed start, stop or remove, or a container that died, makes the device `FAULTED` with a `DEVICE_FAULTED` event.
- While a runtime is being stopped its state is `STOPPING`, so nothing reads the container going down as a failure, and its tags are no longer read (TASK-401).
- A runtime Z-Factory stopped stays `STOPPED` when its state is read again: the container ends with the stop signal's exit code, which is not a fault.
- State mapping: container running + program `RUNNING` → `RUNNING`; running with no or a stopped program → `DEGRADED`; program `ERROR` or a non-zero container exit → `FAULTED`.

### Identity
The hardware profile (manufacturer, family, model) stays on the catalog model of the device instance. The runtime identity is recorded separately as `OpenPLC Runtime <version>` plus the image digest. Nothing claims vendor firmware, vendor timing or real-time behavior: in the container the runtime uses default scheduling.

### I/O point addresses (TASK-302)
Every PLC I/O point has the address a program uses for it. They are assigned by Z-Factory, per class, in channel order (`lib/validation/io-address.ts`):

| Point class | Address | Modbus |
|---|---|---|
| DI | `%MX<byte>.<bit>` | coil `8192 + n` |
| DO | `%QX<byte>.<bit>` | coil `n` |
| AI | `%MW<n>` | holding register `1024 + n` |
| AO | `%QW<n>` | holding register `n` |

Inputs are in memory, not in `%I`: the runtime accepts simulated field values only there (ADR-0010). The vendor's terminal label and address (for example `Ia.0`, `%I0.0`) are kept on the catalog channel and shown next to the program address.

A compact PLC's points are numbered by channel. A module's points start after everything already in use, digital blocks on a byte boundary, so existing addresses never move when modules are added or removed. Tags the user placed by hand are skipped, and a hand-made tag cannot take the address of an I/O point. A PLC has room for 1024 DI, 1024 DO, 256 AI and 256 AO.

### Screens (TASK-305)
The Program, Versions and Runtime screens of a stored PLC call these services through the server actions in `app/factories/[factoryId]/plcs/runtime-actions.ts`. Their read models are in `lib/services/plc-runtime-view-service.ts`:

| Function | Returns |
|---|---|
| `getPlcProgramView` | the versions, the source the editor opens with (requested, selected, newest, or a starter program) and the PLC's tags as located variables |
| `getPlcVersionsView` | program versions and deployment snapshots, newest first |
| `getPlcRuntimeView` | stored state, service name, runtime version, image, Modbus endpoint, selected and deployed program, the last runtime events |
| `readLivePlcState` | reads the state from the runtime and stores it, unless there is no runtime or a start or stop is in progress; a runtime that cannot be asked is a reason to show, not an error |

The starter program (`lib/plc/program-template.ts`) declares each tag as `Name AT <address> : <type>` (BOOL, INT, UINT, DINT, UDINT, REAL), with the device signal as a comment, and ends with the task configuration the runtime needs. Tag names that are not IEC identifiers are left out.

The read models never contain the container id or the runtime's management port. An action returns the domain message of a failure; build-log lines and Docker causes go to the server log only.

A started runtime needs `RUNTIME_SECRET` in production. Without it, runtime operations answer with that reason and the other screens keep working.
