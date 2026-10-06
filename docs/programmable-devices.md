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

## Implementation (TASK-308)
The capability model above is implemented; what follows says what exists and what does not.

### Capabilities are catalog data
`DeviceModel.capabilities` (`DeviceCapability[]`, migration `device_capabilities`) is declared per model in the catalog definitions and checked there: a `PROGRAMMABLE` model lists the capability and no other model does; a model run by the OpenPLC adapter is `PROGRAMMABLE` and `IEC_61131_3`; a `PARAMETER_CONFIGURED` model is `PARAMETER_CONFIGURABLE`; a model that speaks Modbus has a port. Nothing is inferred from a category or a name (`lib/domain/device-capabilities.ts`, `lib/catalog/schema.ts`).

Shipped: the four vendor PLCs are `PROGRAMMABLE`, `IEC_61131_3`, `MODBUS_SERVER` (what Z-Factory does with them through the OpenPLC adapter, not a claim about their firmware). The generic hardwired drive is `PARAMETER_CONFIGURABLE`, `LOCAL_CONTROL`; the Modbus drive `PARAMETER_CONFIGURABLE`, `REMOTE_CONTROL`, `MODBUS_SERVER`; the temperature controller `PARAMETER_CONFIGURABLE`, `LOCAL_CONTROL`; the remote I/O station `REMOTE_IO`, `MODBUS_SERVER`; the gateway `MODBUS_CLIENT`, `MODBUS_SERVER`. Sensors, switches, valves, motors, pumps and the power supply declare none.

### Programmable controllers: PLC and RTU on one workflow
A **programmable controller** is a model of a controller category (`PLC`, `RTU`) with the `PROGRAMMABLE` capability; it declares COMPACT or MODULAR, gets a controller profile, I/O points, a program and a runtime of its own, and uses the PLC screens. A PLC is always one. The shipped `Generic RTU, IEC 61131-3` (new category `RTU`; 8 DI, 4 DO, 4 AI; Ethernet, Modbus TCP) is one too: it takes the same program, version, deploy and runtime workflow as a PLC on the OpenPLC adapter, and nothing in the workflow asks for the category.

Before a program is checked, stored or deployed, the runtime service asks `programSupport(model)`: the model is `PROGRAMMABLE`, `IEC_61131_3` and run by `OPENPLC`, else `program-capability` is refused with the reason; a stored program in a language other than Structured Text is refused with `program-language`. Both happen before any side effect.

### Screens follow the model
`deviceSections(model)` decides which screens a device has: Overview and Connections for every device; Hardware, I/O Mapping, Runtime and Export for a controller; Program and Versions for a `PROGRAMMABLE` model; Parameters for a `PARAMETER_CONFIGURABLE` model; Registers for a model that speaks Modbus; Communications for a model with ports; Runtime for a simulated device (the factory's simulator). A programmable model without an adapter lists Program and Versions as "no adapter" and offers no editor.

- Controllers keep the PLC screens (`/factories/[factoryId]/plcs/[plcId]`); their Program and Versions sections appear from the capability, not from the category.
- Every other device has its own screens (`/factories/[factoryId]/devices/[deviceId]`: Overview, Connections, Parameters, Registers, Communications), reached from the factory overview and the designer's inspector. A controller opened there is sent to its PLC screens.
- A `SCRIPTABLE` or `FIRMWARE_DEPLOYABLE` model has no adapter and therefore no screen; the capabilities exist so that a catalog record can state them.

### Parameters and configuration versions
The Parameters screen shows the numeric parameters of the device's behaviour model (`lib/domain/device-parameters.ts`: for a drive the maximum frequency and the ramp times; for a motor, pump, load or valve theirs). Saving validates the values with the behaviour model's own schema, writes an immutable `ConfigurationVersion` (scope `DEVICE_PARAMETERS`, numbered, with who saved it) and makes the values the device's simulation profile; a simulation that is running keeps its values until it is started again. A `PARAMETER_CONFIGURABLE` model without a behaviour model (the temperature controller, the Modbus drive) shows the screen and says that no parameter set is defined, or that its values drive nothing.

### Registers
A device has no address space of its own in Z-Factory. Its Registers screen lists the controller tags that carry its signals, with program address and Modbus address, read from the canonical wiring of TASK-307.

### Not done
- No scripting or firmware adapter; `SCRIPTABLE` and `FIRMWARE_DEPLOYABLE` are declarable, not usable.
- No vendor RTU record: the only RTU is generic.
- Parameters exist only where a behaviour model has them; a parameter set declared by a catalog model for its own sake (drive registers, controller tuning) is not modelled.
- `ProtocolRegisterDefinition` is still not read anywhere; the Registers screen shows tags, not a vendor register map.

