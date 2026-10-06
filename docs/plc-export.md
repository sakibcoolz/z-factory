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
7. Full tag list (with the process-module signals its tags carry, TASK-605; each tag in the JSON and CSV says who drives it, `authority`, TASK-205)
8. Modbus/register map including type/scaling/access/role
9. Connected device schedule
10. Device-to-device/control relationships
11. Gateway/network/protocol configuration (with the PLC-to-PLC links the PLC takes part in, TASK-701, and the values each carries — direction, client tag, server tag and register, type, interval, state — TASK-704)
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

## Implementation (TASK-304)
Code: `lib/export/` (document model, CSV, redaction check, diagram layout), `lib/services/plc-export-service.ts` (builder), `components/export/plc-report.tsx` (report), routes under `/factories/[factoryId]/plcs/[plcId]/export`.

### One document, several outputs
`buildPlcExport` produces one normalized document (`schema: "z-factory.plc-export"`, `schemaVersion: 1`) from the PLC's current configuration. The report, the CSV schedules and the JSON file are all rendered from that document, so they cannot disagree.

| Output | Where | Content |
|---|---|---|
| Report | `/export` (preview in the shell), `/export/report` (the report alone, for printing) | the 15 sections above, A4 / Letter |
| PDF | the browser's print dialog on `/export/report` | print stylesheet: paper layout, no application chrome, rows and sections kept together |
| JSON | `/export/files/plc.json` | the whole document |
| CSV | `/export/files/io.csv`, `tags.csv`, `devices.csv` | I/O schedule (every channel), tags with Modbus map, connected-device schedule |

Downloads are named `<PLC name>-<revision>-<file>`. CSV is UTF-8 with a byte-order mark, RFC 4180 quoting, CRLF line ends. A cell that a spreadsheet would run as a formula is prefixed with an apostrophe.

### What each section is built from
- 1–4: factory, PLC instance, catalog model with its source and verification date, supply, ports and recorded facts.
- 5–6: built-in channels or rack, slots and modules; every channel with vendor address, program address, device, terminal and tag. The report prints channels in use; free channels are in the I/O CSV.
- 7–8: the tag registry with role, type, addresses, access, byte and word order, scale and offset.
- 9: one row per wired channel and per protocol link, in the column order given above.
- 10 and 14: every relationship and device reachable from the PLC over any connection. Devices of the factory that are not connected to it, directly or through others, are left out.
- 11: the PLC's name in the factory network, its Modbus endpoint, protocol devices. Gateways are not modelled yet.
- 12: current program version with checksum and status, mapping versions, the configuration snapshot of the last deployment, runtime image and version.
- 13: only when requested (`?runtime=1`): the state last stored by Z-Factory, marked as not live.
- 15: export time and configuration revision.

### Revision
`revision.configuration` is the first 12 hex digits of a SHA-256 over the document without its timestamp and runtime snapshot. The same configuration always gives the same revision; any configuration change gives another.

### Security
- The document is assembled from fields that hold engineering data. Container ids, the management API port, credentials and the Docker endpoint are never read into it.
- Before any output is returned, `assertExportIsClean` scans the whole document for field names and values that must not leave the system (secrets, tokens, container ids, the Docker socket or endpoint, private keys, host paths). A finding stops the export; the error names the place, not the content.
- Included on purpose because a gateway needs them: the Modbus bind address and host port, the PLC's name in the factory network, the factory subnet, the public runtime image reference.
- Downloads require the owner, answer 404 for anything else, and are sent with `Cache-Control: no-store`.

### Not implemented
- A server-generated PDF file. The PDF comes from the browser's print dialog.
- The configuration package (program and generated runtime mappings as an archive) and importing an export.
- Choosing which sections to include; the report always has all 15.
- Reproducing an export from a stored snapshot: the export reflects the configuration at the time it is made and names its revision.
