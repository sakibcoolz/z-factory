# TASK-905 — Remote Command/Setpoint Lifecycle, Authorization & Audit

Status: **TODO**

Phase: **09 — MVP 2: Production Edge & Cloud Integration**

## Objective
Implement the safe Web Factory -> MQTT -> Thin Client -> PLC command path while preserving PLC program/interlock authority.

## Scope
- Command/setpoint UI only for mappings declared remotely writable.
- Server-side authorization, validation and audit before publish.
- Command envelope with commandId, target site/agent/plc/mapping, value/type, config version and requestedBy.
- MQTT publish from Web Factory server only.
- Thin Client independently re-validates its exported allow-list.
- Idempotency for duplicate MQTT delivery.
- Command lifecycle: REQUESTED -> PUBLISHED -> ACCEPTED/REJECTED -> APPLIED/FAILED, with timeout state.
- Correlate acknowledgement and subsequent PLC feedback.
- Never expose arbitrary Modbus address write from the cloud UI.
- Never use normal remote control to force local physical output image directly.

## Acceptance criteria
- Unauthorized/unmapped/out-of-range commands are rejected before publish or by the edge allow-list.
- Duplicate commandId cannot repeat actuation.
- Every command has an auditable user, target, value, timestamps and result.
- Feedback/acknowledgement is visible in Web Factory.
- PLC program/interlocks remain the final authority for physical outputs.
