# TASK-301 — Device Catalog & Provenance

Status: **READY**
Linear: [ZFA-12](https://linear.app/recruit-verse/issue/ZFA-12)

## Objective
Populate normalized PLC and industrial peripheral profiles from authoritative sources and seed generic categories needed by the factory designer.

## Initial PLC targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241

## Peripheral categories
Field/process devices include VFDs/drives, motors, pumps, fans/blowers, conveyors, mixers, compressors, valves, actuators, relays/contactors, switches, heaters, encoders and temperature/pressure/level/flow/proximity/photoelectric/vibration/current/voltage/position sensors.

## Industrial control / intermediate device categories
The catalog must also support devices that commonly sit between PLC logic and field equipment or aggregate remote signals:
- VFD / variable-frequency drive
- servo drive
- soft starter
- motion controller
- PID / process controller
- temperature controller
- robot/controller interface
- safety relay and safety-controller metadata (simulation only; not safety-rated)
- remote I/O / distributed I/O
- IO-Link master
- protocol converter / industrial gateway
- signal conditioner / isolator
- analog transmitter / converter
- motor starter / intelligent motor protection relay where applicable
- industrial edge gateway
- HMI/SCADA endpoint metadata where needed

Some controllers are programmable/configurable; others are parameter-driven. Runtime behavior must be declared by model capability and never inferred only from category.

## Relationship examples
```text
PLC -> VFD -> Motor -> Pump
PLC -> Servo Drive -> Servo Motor
PLC -> Remote I/O -> Sensors / Valves
PLC -> Temperature Controller -> Heater
PLC -> Gateway / Protocol Converter -> External Device Network
```

An intermediate device is not mandatory in every connection. Many sensors/switches may connect directly to PLC I/O.

## Acceptance criteria
- Model and factory instance concepts remain separate.
- For verified vendor records capture exact model/SKU, documented electrical/comms/I/O/register facts, source URL/revision/date and verification timestamp.
- Device category records capture simulator/control relationship metadata such as requiresMotor/requiresDrive/preferredDriveType.
- Catalog metadata can describe direct PLC I/O, smart/protocol device, configurable controller and programmable-controller capability.
- Compatibility metadata supports PLC I/O and protocol filtering.
- Device relationship rules can represent controller/drive/remote-I/O chains without forcing an intermediate device where none exists.
- Never invent pinouts/register maps or copy full manuals into the repository.
