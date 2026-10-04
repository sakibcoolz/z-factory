# TASK-501 — Industrial Edge / Raspberry Pi Connectivity

Status: **PLANNED**
Linear: [ZFA-18](https://linear.app/recruit-verse/issue/ZFA-18)

## Objective
Allow a physical industrial edge gateway/Raspberry Pi on the LAN to reach selected PLC endpoints through controlled Docker-host published ports.

## Acceptance criteria
- Network prerequisites documented.
- Bind address configurable.
- Port/firewall guidance.
- Gateway connection stores PLC host/port/unit ID/polling/mapping metadata.
- Modbus read/write verification from edge client.
- Writes target PLC command/setpoint tags only.
- Feedback/status values can be read back.
- Command request and actual device result remain distinguishable.
- No Docker socket/API exposed to edge client.
