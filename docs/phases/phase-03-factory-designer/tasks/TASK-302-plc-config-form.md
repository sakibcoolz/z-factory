# TASK-302 — Compact & Modular PLC Configuration

Status: **PLANNED**
Linear: [ZFA-13](https://linear.app/recruit-verse/issue/ZFA-13)

## Objective
Build a dynamic PLC create/edit UI driven by catalog metadata, including factory-specific connected peripherals and I/O/tag/protocol assignments.

## Compact path
Built-in DI/DO/AI/AO, terminals/channels, electrical metadata, communication ports, occupancy and compatible peripheral picker.

## Modular path
CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals -> occupancy -> compatible peripheral picker.

## Acceptance criteria
- User creates a uniquely named PLC instance with separate process role.
- Incompatible modules cannot be selected.
- Expansion/slot limits enforced.
- Peripheral-to-channel signal/type compatibility validated.
- Occupied pins/channels cannot be double-assigned.
- Selected devices can be mapped to PLC pin/channel/tag/Modbus endpoints.
- Pin/channel visualization is data-driven.
- PLC edit view exposes overview, hardware, connections, program, I/O mapping, simulator, live tags, logs, versions, runtime and export.
- Configuration persists and reloads correctly.
- Unit/component tests cover both compact and modular paths.
