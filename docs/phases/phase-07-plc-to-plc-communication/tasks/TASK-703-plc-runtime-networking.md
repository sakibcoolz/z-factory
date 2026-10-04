# TASK-703 — PLC-to-PLC Runtime Adapter & Docker Networking

Status: **PLANNED**

## Goal
Make independently running OpenPLC containers communicate through Modbus TCP on the isolated factory Docker network.

## Scope
- deterministic Docker DNS/service name per PLC
- internal Modbus TCP endpoint discovery
- client connection lifecycle
- connection timeout/retry/backoff
- polling scheduler
- read/write execution
- runtime health and communication quality
- structured events for connect/disconnect/error/recovery
- no hard-coded container IP addresses
- integration tests with two OpenPLC containers

## Runtime flow
```text
PLC-A Program
   |
   | local communication tag
   v
PLC-to-PLC Modbus Client Adapter
   |
   | factory Docker network
   v
PLC-B OpenPLC Modbus Server
   |
   v
PLC-B tag/register -> PLC-B local logic
```

## Invariants
- Containers communicate by deterministic service/DNS name, not fixed IP.
- Host-published ports are not required for PLC-to-PLC traffic inside the factory network.
- One failed PLC link must not crash unrelated PLC runtimes.
- Retry behavior is bounded and observable.
- Runtime writes obey the mapping access rules from TASK-702.

## Acceptance
- Two PLC containers exchange configured values over the factory network.
- Restarting the target PLC produces disconnected/stale state and later recovery.
- Connection failures generate useful runtime events without corrupting tag state.
