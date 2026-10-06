# Phase 05 — External Gateway MVP

Status: **IN PROGRESS**

| Task | Status |
|---|---|
| TASK-501 Industrial edge/Raspberry Pi connectivity | DONE |
| TASK-502 End-to-end virtual factory demo | DONE |
| TASK-503 Z-Factory Thin Client Agent — File-Driven Dynamic PLC Connectivity, Concurrency & MQTT Cloud Uplink | IN PROGRESS (503a done; 503b MQTT done; 503c spool follows) |

Phase 05 is reopened for the production edge-agent follow-up in TASK-503. TASK-501/502 remain complete and define the existing controlled gateway endpoint and virtual E2E proof.

TASK-503 replaces the software-only edge stand-in with a standalone Go thin client that runs on Raspberry Pi, industrial gateway, Linux host or a virtual edge node. Z-Factory exports versioned per-PLC JSON deployment files; the agent validates/stages them and dynamically reconciles one supervised logical worker per active PLC. Workers read exported telemetry mappings over Modbus TCP, feed bounded MQTT publishing with local store-and-forward, and receive cloud commands through an MQTT command router. Downlink writes are restricted to explicitly exported command/setpoint mappings; PLC logic remains authoritative for local physical outputs.

Exit criteria: TASK-501 and TASK-502 remain verified; TASK-503 proves exported JSON -> dynamic supervised PLC workers -> Modbus telemetry -> MQTT cloud uplink, plus MQTT command -> validated command/setpoint Modbus write -> PLC logic -> feedback, with hot config reload, fault isolation, bounded concurrency/backpressure, offline buffering/recovery and no central database dependency.
