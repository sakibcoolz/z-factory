# TASK-301 — Device Catalog & Provenance

Status: **PLANNED**
Linear: pending

## Objective
Populate normalized PLC and industrial peripheral profiles from authoritative sources and seed generic categories needed by the factory designer.

## Initial PLC targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241

## Peripheral categories
VFDs/drives, motors, pumps, fans/blowers, conveyors, mixers, compressors, valves, relays/contactors, switches, temperature/pressure/level/flow/proximity/photoelectric/vibration/current/voltage/position sensors, encoders, remote I/O and industrial gateways.

## Acceptance criteria
- Model and factory instance concepts remain separate.
- For verified vendor records capture exact model/SKU, documented electrical/comms/I/O/register facts, source URL/revision/date and verification timestamp.
- Device category records capture simulator/control relationship metadata such as requiresMotor/requiresDrive/preferredDriveType.
- Compatibility metadata supports PLC I/O filtering.
- Never invent pinouts/register maps or copy full manuals into the repository.
