# TASK-304 — PLC Engineering Export

Status: **DONE**
Linear: [ZFA-15](https://linear.app/recruit-verse/issue/ZFA-15)

## Goal
Export a PLC instance as a complete engineering snapshot.

## Scope
- Print-friendly PLC report
- PDF-oriented rendering/export
- CSV I/O and tag schedules
- JSON normalized configuration export
- Connected-device and topology sections
- Program/config/mapping/runtime version metadata
- Compact and modular PLC layouts
- Security redaction rules

## Acceptance
- Export includes PLC identity/specs, I/O/rack, tags/registers, connected devices, mappings and topology.
- Export references a configuration revision/timestamp.
- No secrets or privileged Docker information is exposed.

## Evidence (2026-10-05)
- **Export includes identity/specs, I/O/rack, tags/registers, connected devices, mappings and topology.** One document (`lib/export/plc-export.ts`) feeds the report, the JSON file and three CSV schedules. Integration tests check each part for a compact PLC (built-in I/O) and a modular one (rack, slots, modules).
- **Export references a configuration revision and timestamp.** `revision.configuration` is a hash of the exported configuration: unchanged by time or by the runtime snapshot, changed by any configuration change. Program version and checksum, mapping versions and the last deployment snapshot are included.
- **No secrets or privileged Docker information.** Container id, management port, credentials and Docker endpoint are planted in the test database and are absent from JSON, CSV and report. A redaction check scans every export and stops it on a finding without repeating the finding.
- **Print-friendly, PDF-oriented report.** All 15 sections of `docs/plc-export.md`; printed from headless Chrome it is a 4-page A4 PDF without application chrome.
- Tests: 11 unit tests (CSV, redaction, diagram, sections), 5 report component tests, 10 builder tests and 4 download-route tests against PostgreSQL. 489 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.

## Decisions made in this task
- **PDF through the browser.** The report has a print stylesheet and its own page; no PDF library or headless browser is added to the server.
- **The export covers the PLC's part of the factory**: every device reachable from the PLC over any connection. Unconnected devices are left out.
- **Kept in the export on purpose:** Modbus bind address and host port, the PLC's name in the factory network, the factory subnet and the public runtime image reference. A gateway needs them and none is a credential.
- **Formula-safe CSV:** cells that a spreadsheet would execute are neutralised.

## Not in this task
- The configuration package (program and runtime mappings as an archive) and importing an export, both named in `docs/plc-export.md`.
- A section picker; a server-generated PDF file.
- Reproducing an export from a stored snapshot; the export shows the configuration as it is when made.
- Gateways in section 11: none are modelled until Phase 05.
