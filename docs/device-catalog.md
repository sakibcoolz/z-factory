# Device Catalog

## Purpose
Normalize real industrial hardware metadata for UI rendering, compatibility validation, runtime generation, simulation, and engineering export.

Catalog definitions are reusable and are never the same object as factory-specific device instances.

Process-specific assemblies such as a boiler are **not** generic hardware catalog models. They are ProcessModuleTypes that compose existing catalog-backed device instances. See `docs/process-modules.md`.

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
- A boiler module may assign heater, temperature sensors, level transmitter, pump and valves to process roles and then allocate its logical PLC I/O.

## Source policy
Use manufacturer product pages/manuals as authoritative sources. Store normalized facts and URLs; do not ingest protected manuals/CAD/images unless licensing allows.
