# TASK-301 — Device Catalog & Provenance

Status: **PLANNED**
Linear: pending

## Objective
Populate normalized device profiles from authoritative manufacturer sources.

## Initial targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241

## Acceptance criteria
For every record capture exact model/SKU, architecture type, documented supply/comms/I/O/rack/module facts, source URL, source document/revision/date where available, and verification timestamp. Never invent pinouts. Do not copy full manuals into the repository.
