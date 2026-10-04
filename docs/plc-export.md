# PLC Engineering Export / Print

## Requirement
Every PLC instance can be printed/exported as a complete engineering snapshot of its current versioned configuration.

## Human-readable export
The PDF-oriented report should contain:
1. Factory and PLC identity
2. Manufacturer/family/exact model/SKU and architecture type
3. PLC process role and runtime (OpenPLC)
4. Power/electrical and communication summary from verified catalog data
5. Built-in I/O or rack/module/slot structure
6. Pin/channel occupancy and terminal assignments
7. Full tag list
8. Modbus/register map including type/scaling/access/role
9. Connected device schedule
10. Device-to-device/control relationships
11. Gateway/network/protocol configuration
12. Program/config/runtime versions
13. Runtime health/status snapshot when requested
14. Topology/wiring diagram
15. Export timestamp and configuration revision

## Connected-device schedule
Example columns:
`PLC Point | Tag | Device Instance | Model | Relationship | Signal/Protocol | Address | Unit`.

## Machine-readable exports
- CSV for I/O and tag schedules
- JSON for complete normalized configuration
- configuration package containing program and generated runtime mappings for reproducibility/import

## Versioning
Export must reference immutable program/config/mapping versions where available. A report should be reproducible from the recorded configuration snapshot.

## Security
Secrets, credentials, Docker socket details and sensitive host paths must never appear in exports.
