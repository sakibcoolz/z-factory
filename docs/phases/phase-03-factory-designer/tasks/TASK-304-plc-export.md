# TASK-304 — PLC Engineering Export

Status: **READY**
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
