# ADR-0002 — OpenPLC as First PLC Runtime

Status: Accepted

## Decision
OpenPLC is the first executable PLC runtime. Modbus TCP is the first industrial protocol.

Vendor hardware catalog entries are descriptive/simulation profiles and do not imply running vendor firmware.

## Consequences
The system must keep hardware profile, PLC program, logical I/O mapping and runtime adapter as separate concepts.
