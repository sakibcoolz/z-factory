# TASK-906 — Production Edge Deployment, Resilience, Security & Physical E2E

Status: **TODO**

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Prove MVP 2 on a real/industrial edge host with multiple dynamic PLC configurations, cloud MQTT, Web Factory, offline recovery and measurable bounded-resource behavior.

## Scope
- Deploy Go Thin Client Agent via systemd and/or container on Raspberry Pi/industrial Linux gateway.
- Validate exported JSON staging/active/rejected lifecycle and hot reload.
- Run configurable N PLC workers; no fixed 150 assumption.
- Measure CPU, memory, goroutines, queue depth, spool size and network behavior.
- Validate one PLC failure/slow response does not impact others.
- Validate cloud/MQTT outage: PLC polling continues, telemetry spools locally, controlled replay after reconnect.
- Validate agent restart and last-known-good configuration recovery.
- Validate TLS/mTLS/credential rotation approach and no plaintext production secrets in exported JSON.
- End-to-end: PLC -> Thin Client -> MQTT -> Web Factory telemetry and Web Factory -> MQTT -> Thin Client -> allowed command/setpoint -> PLC logic -> feedback.
- Failure injection for broker outage, PLC outage, malformed config, duplicate command and disk/spool pressure.

## Acceptance criteria
- Physical edge deployment is repeatable.
- Dynamic multi-PLC workers remain isolated and bounded under load.
- Offline store-and-forward survives restart and reconnect.
- Web Factory receives telemetry and command acknowledgements end to end.
- Security/observability evidence is captured.
- All failure/recovery E2E scenarios pass without bypassing PLC control authority.
