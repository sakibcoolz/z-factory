# Programmable Devices — End-to-End Model

## Purpose
Z-Factory must support programming and configuration for industrial controllers beyond PLCs without pretending that every device is programmable in the same way.

The UI and runtime behavior are capability-driven, not hard-coded to a device category.

## Supported controller classes
Initial programmable/configurable controller classes:
- PLC
- RTU
- programmable process controller
- motion controller
- servo controller/drive when the selected model supports logic
- intelligent gateway/edge controller when the selected model supports scripting or logic

Configuration-oriented classes:
- VFD / drive
- PID controller
- temperature controller
- soft starter
- protocol converter
- remote I/O

A VFD is not treated like a PLC by default. Most VFD workflows are parameter/register configuration. A Program tab appears only when the selected model explicitly declares programmable logic capability.

## Capability model
A catalog model can declare capabilities such as:
- `PROGRAMMABLE`
- `IEC_61131_3`
- `SCRIPTABLE`
- `PARAMETER_CONFIGURABLE`
- `LOCAL_CONTROL`
- `REMOTE_CONTROL`
- `DATA_LOGGING`
- `MODBUS_CLIENT`
- `MODBUS_SERVER`
- `REMOTE_IO`
- `FIRMWARE_DEPLOYABLE`

Capability metadata determines which screens, validation rules and runtime adapters are available.

## UI behavior
The device detail UI is assembled from capabilities.

### PLC / programmable RTU
Typical tabs:
`Overview | Hardware | I/O | Connections | Program | Versions | Communications | Runtime | Live Tags | Events`

### VFD / parameter-driven controller
Typical tabs:
`Overview | Connections | Parameters | Registers | Runtime | Telemetry | Faults`

### Scriptable gateway / controller
Typical tabs:
`Overview | Connections | Script | Versions | Communications | Runtime | Logs`

The Program/Script tab must never appear merely because a device belongs to a controller category. It appears only when the exact catalog model supports that capability.

## Program lifecycle
For a programmable device:

```text
UI editor
 -> validate source/language against model capability
 -> save immutable version
 -> compile/translate when required
 -> deploy to selected runtime adapter
 -> start/reload/restart as required
 -> execute
 -> read/write canonical tags/I/O
 -> publish runtime/events
```

The programming framework is shared, but the compiler/deployer/runtime adapter is model/runtime specific.

## RTU rule
An RTU may support local control logic, alarms, data acquisition, communications and fallback behavior. Z-Factory therefore models RTU programming per exact model capability. Some RTUs may support IEC 61131-3 logic; others may use vendor-specific scripting or configuration only.

## VFD rule
VFDs are configuration-first:
- run/stop and direction commands
- frequency/speed setpoint
- acceleration/deceleration
- current/torque/voltage limits
- fault/reset behavior
- communication/register parameters

A full PLC-style program editor is not shown unless the exact drive profile explicitly supports programmable logic.

## Runtime identity
Keep these concepts independent:
- hardware model
- device instance
- programming/configuration capability
- runtime adapter
- program/config version
- process role

A real vendor profile does not imply that Z-Factory runs the vendor firmware.

## Wiring dependency
Programming/configuration consumes the canonical endpoint mapping from TASK-307. Program variables, tags, I/O points and protocol registers must resolve to persisted valid physical/logical connections rather than maintaining a second mapping source.

## Acceptance rules
- UI is capability-driven.
- PLC and RTU can share the program/version framework when capabilities match.
- VFDs default to parameter configuration, not PLC-style coding.
- Unsupported programming options are never shown.
- Source/version/deployment history is stored per programmable device instance.
- Runtime errors are surfaced without corrupting the last valid version.
- Existing OpenPLC-backed PLC behavior remains compatible.
