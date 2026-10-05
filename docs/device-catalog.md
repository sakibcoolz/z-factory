# Device Catalog

## Purpose
Normalize real industrial hardware metadata for UI rendering, compatibility validation, runtime generation, simulation, and engineering export.

Catalog definitions are reusable and are never the same object as factory-specific device instances.

Process-specific machines or assemblies are **not** generic hardware catalog models. They are ProcessModuleTypes that compose existing catalog-backed device instances. See `docs/process-modules.md`.

## Initial PLC targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241 family

These entries do not imply official vendor Docker images or firmware emulation.

## Industrial device categories to seed
### Controllers and intermediate/control-interface devices
- PLC / programmable controller
- VFD / variable-frequency drive
- servo drive
- soft starter
- motion controller
- PID / process controller
- temperature controller
- robot/controller interface
- safety relay / safety-controller metadata (simulation only; never safety-rated)
- remote I/O / distributed I/O
- IO-Link master
- protocol converter / industrial gateway
- signal conditioner / isolator
- analog transmitter / converter
- motor starter / intelligent motor protection relay
- industrial edge gateway
- HMI/SCADA endpoint metadata where needed

### Field/process devices
- motor
- centrifugal/dosing/vacuum pump
- fan / blower / cooling-tower fan
- conveyor / feeder
- mixer / agitator
- compressor
- spindle / centrifuge / hoist where applicable
- solenoid valve
- modulating/control valve
- pneumatic actuator/cylinder
- relay / contactor / SSR
- heater
- stack light / alarm lamp / buzzer
- push button / selector / limit / float / pressure switch / E-stop status contact
- proximity / photoelectric sensor
- temperature sensor/transmitter
- pressure sensor/transmitter
- level sensor/transmitter
- flow sensor/transmitter
- humidity / vibration / current / voltage / position sensor
- encoder

An intermediate device is optional. Direct sensor/switch/actuator wiring to PLC I/O remains a first-class topology.

## Required model metadata
Manufacturer, family, exact model/SKU, device category, lifecycle, supply/electrical data, I/O requirements/capabilities, signal ranges, terminals, communication ports/protocols, register maps when authoritative, engineering units, faults, dimensions/reference metadata, simulator type, drive/motor relationship capabilities, programmability/configuration capability, source URL, source revision/date, verification timestamp.

## Controller/runtime capability
A device profile may declare whether it is:
- passive/direct I/O
- parameter-configured
- protocol-controlled
- programmable
- externally simulated/emulated
- unsupported for executable runtime

Do not assume every controller needs custom code. PID/temperature controllers may be parameter-driven, while motion/robot/programmable controllers may require executable logic. If no legal/usable runtime or emulator exists, Z-Factory simulates documented behavior rather than pretending to run vendor firmware.

## Drive relationship metadata
Do not assume every motor-driven device requires a VFD.

Model capabilities can express:
- `requiresMotor`
- `requiresDrive`
- `preferredDriveType = VFD | SERVO | SOFT_STARTER | DIRECT_ON_LINE`

MVP invariant: one VFD instance drives one primary motor instance.

## PLC compatibility
The factory designer filters peripherals using:
- available DI/DO/AI/AO or installed modular I/O
- voltage/signal type
- channel occupancy
- protocol support
- module compatibility
- smart-device register/protocol capability

## Runtime mapping
Hardware profiles may map to OpenPLC or generic device simulators only when semantics are explicitly defined. UI must disclose OpenPLC-backed simulation vs native vendor runtime.

Generic device simulation stays device-centric. A process module may couple several devices and virtual/process values, but it must reference catalog-backed devices rather than invent process-specific vendor hardware facts.

Examples:
- PLC -> VFD -> motor -> pump is a valid relationship chain.
- PLC -> remote I/O -> sensors/valves is a valid distributed-I/O chain.
- PLC -> temperature controller -> heater is a valid controller chain.
- Sensor -> PLC direct I/O is valid and requires no intermediate device.
- A machine/process module may assign sensors, drives, actuators and controllers to process roles and then allocate its logical PLC I/O.

## Source policy
Use manufacturer product pages/manuals as authoritative sources. Store normalized facts and URLs; do not ingest protected manuals/CAD/images unless licensing allows.

## Implementation (TASK-301)
Code: `lib/catalog/` (definitions, rules, import), `lib/domain/catalog.ts` (vocabulary), `lib/validation/compatibility.ts`, `lib/services/catalog-service.ts`. Screen: `/catalog`.

### Where catalog facts live
Catalog records are data files in the repository, written to the database by `npm run db:seed`:

- `lib/catalog/vendor/*.ts`: vendor records. Each names the manufacturer document it was read from. Sources are listed in `docs/references/catalog-sources.md`.
- `lib/catalog/generic-models.ts`: generic simulated models. No order number, no source, status `GENERIC`.
- `lib/catalog/generic-categories.ts`: the 35 device categories with simulator type and drive relationship.

The import matches every row by its natural key and updates it in place, so it can be repeated and ids used by factory data stay stable. It never deletes.

### Rules checked before anything is written
- A `VERIFIED` record carries source URL, title, revision and retrieval date, and a verification date.
- A vendor record has its exact order number; a generic record has none and belongs to the manufacturer `Generic / simulated`.
- Only PLC models declare an architecture. A modular PLC has no built-in channels; a module is compatible only with modular CPUs of its own family.
- A terminal may name a simulator signal only if the device type has that signal in that direction. A model may list only faults its behaviour model supports.
- Unknown fields, categories and manufacturers are rejected.

### Vendor records (all verified on 2026-10-05)
| Model | Order no. | Architecture | I/O | Modbus TCP |
|---|---|---|---|---|
| Siemens SIMATIC S7-1200 CPU 1214C DC/DC/DC | 6ES7214-1AG40-0XB0 | compact | 14 DI, 10 DO (24 V DC), 2 AI (0–10 V) | stated |
| Siemens SIMATIC S7-1500 CPU 1511-1 PN | 6ES7511-1AK02-0AB0 | modular | DI 16, DQ 16, AI 8, AQ 4 modules | stated |
| Rockwell CompactLogix 5380 5069-L306ER | 5069-L306ER | modular | 5069-IB16, -OB16, -IF8, -OF4 modules | not stated in the source, not claimed |
| Schneider Modicon M241 TM241CE24T | TM241CE24T | compact | 14 DI, 10 DO (24 V DC) | stated |

"M241" names a family; the record is the TM241CE24T (24 I/O, transistor source outputs, Ethernet).

Recorded per model: supply voltage and range, communication ports, channel counts and signal types, and further facts such as memory and expansion limits. Terminal labels and address hints are recorded only where the source prints them.

### Not recorded
- Lifecycle status (`UNKNOWN` for every model).
- Register maps, fault codes and pinouts of vendor devices.
- Slot rules of modules, and power-supply modules.
- S7-1200 signal modules and M241 TM3 expansion modules: expansion of a compact PLC is not modelled yet.
- The S7-1200 facts come from the 01/2015 Easy Book; later hardware revisions with the same order number were not compared.

### Signal types and compatibility
Signal codes: `DC_24V`, `VOLTAGE_0_10V`, `VOLTAGE_0_5V`, `VOLTAGE_1_5V`, `VOLTAGE_PM_10V`, `CURRENT_4_20MA`, `CURRENT_0_20MA`, `CURRENT_PM_20MA`.

A device terminal fits a PLC channel when the point class matches (a device output needs a PLC input, and vice versa) and the channel accepts the signal: its default type, a type it can be configured for, or a signal whose range lies inside one of those (a ±10 V input carries 0–10 V). The range rule is Z-Factory's, not a vendor statement.

`listCompatiblePeripherals` evaluates a PLC model:
- Compact PLC: every terminal needs its own built-in channel, so channel counts matter.
- Modular PLC: a terminal fits when at least one installable module has a channel for it.
- Protocol devices fit when both sides have a port for the same protocol.

Occupancy of a specific PLC instance is checked when a device is wired (TASK-302).

### Control capability and runtime
`controlCapability` (direct I/O, parameter-configured, protocol-controlled, programmable) and `runtimeSupport` are set per model. Two models of one category can differ: the generic VFD exists hardwired and as a Modbus TCP device. Models without a behaviour model (contactor, heater, stack light, temperature controller, remote I/O, gateway, Modbus TCP VFD) are `NONE`: they can be placed and wired but are not executed.

### Relationships
`DRIVES` accepts a VFD, servo drive or soft starter as source and a motor or servo motor as target; a servo motor needs a servo drive. One drive drives one motor. `CONTROLS`, `COMMUNICATES_WITH`, `MEASURES` and `FEEDS_BACK_TO` are unrestricted, so controller, remote-I/O and gateway chains and direct sensor-to-PLC wiring are all representable.

## 3D assets (TASK-402, ADR-0012)
A catalog model may have a reusable 3D asset: versions of a GLB recorded as `Catalog3dAsset`, one of them active. Every factory instance of the model is drawn from the active version. A model without one is drawn as the generic shape of its category (`lib/scene/placeholders.ts`), which also gives the space an asset is fitted into. Shapes and sizes are generic; none is a vendor dimension, and an asset must not imitate a manufacturer's housing. Generating assets is TASK-403.
