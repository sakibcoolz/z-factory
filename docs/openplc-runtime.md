# OpenPLC Runtime

## Role
OpenPLC is the first executable PLC runtime in Z-Factory.

## Principle
The OpenPLC runtime is separate from the selected hardware profile. A user may select a catalog profile for visualization/I/O modeling while the runtime is OpenPLC, provided the UI clearly labels it as an OpenPLC-backed simulation.

## Program
PLC programs are stored as project artifacts/records and exposed in a Program tab. Initial supported text representation should prioritize IEC 61131-3 Structured Text; ladder editing can follow later.

## I/O mapping
Z-Factory maps catalog/channel selections -> logical IEC addresses -> protocol addresses. Mapping must be explicit and persisted.

## Container lifecycle
Create -> configure -> start -> health check -> running -> stop/restart/remove.

## Required runtime metadata
Runtime version, image digest/tag, program version, I/O mapping version, container/network IDs, protocol ports, health/runtime state.

## MVP boundary
Do not claim OpenPLC reproduces exact hardware timing, electrical behavior, proprietary backplanes, or vendor engineering-suite compatibility.
