# Device Catalog

## Purpose
Normalize real industrial hardware metadata for UI rendering, compatibility validation, runtime generation, simulation, and engineering export.

Catalog definitions are reusable and are never the same object as factory-specific device instances.

## Initial PLC targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241 family

These entries do not imply official vendor Docker images or firmware emulation.

## Industrial device categories to seed
- PLC / controller
- VFD / variable-frequency drive
- servo drive
- soft starter
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
- remote I/O
- industrial edge/protocol gateway
- HMI/SCADA endpoint metadata where needed

## Required model metadata
Manufacturer, family, exact model/SKU, device category, lifecycle, supply/electrical data, I/O requirements/capabilities, signal ranges, terminals, communication ports/protocols, register maps when authoritative, engineering units, faults, dimensions/reference metadata, simulator type, drive/motor relationship capabilities, source URL, source revision/date, verification timestamp.

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

## Source policy
Use manufacturer product pages/manuals as authoritative sources. Store normalized facts and URLs; do not ingest protected manuals/CAD/images unless licensing allows.
