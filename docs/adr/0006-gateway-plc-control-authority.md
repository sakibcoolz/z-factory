# ADR 0006 — Gateway Commands Preserve PLC Control Authority

Status: Accepted — 2026-10-04

## Decision
External industrial gateways use Modbus TCP to read/write PLC mappings. Writes target PLC command/setpoint tags/registers. PLC logic remains responsible for interlocks and downstream VFD/motor/pump/valve behavior.

## Consequences
- Gateway never directly mutates downstream device simulator state.
- Command/setpoint and feedback/status mappings are separate.
- API/UI must represent requested command vs actual result.
- End-to-end tests must prove gateway write -> PLC logic -> device response -> feedback read.
