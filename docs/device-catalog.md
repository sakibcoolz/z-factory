# Device Catalog

## Purpose
Normalize real industrial hardware metadata for UI rendering, compatibility validation, and virtual runtime generation.

## Initial catalog targets
- Siemens S7-1200 CPU 1214C DC/DC/DC.
- Siemens S7-1500 CPU 1511-1 PN.
- Rockwell CompactLogix 5380 5069-L306ER.
- Schneider Modicon M241 family.

These entries do not imply official vendor Docker images or firmware emulation.

## Required fields
Manufacturer, family, exact model/SKU, device type, compact/modular architecture, supply data, communication ports/protocols, onboard I/O where applicable, rack/slot capability, compatible modules, channel/terminal information, dimensions/reference metadata, source URL, source revision/date, verification timestamp.

## Runtime mapping
For MVP, hardware profiles may map to OpenPLC or generic Modbus simulators only when semantics are explicitly defined. The UI must disclose when a profile is simulated through OpenPLC rather than native vendor runtime.

## Source policy
Use manufacturer product pages and manuals as authoritative sources. Store normalized facts and URLs; do not ingest full manuals or protected CAD/images unless licensing allows.
