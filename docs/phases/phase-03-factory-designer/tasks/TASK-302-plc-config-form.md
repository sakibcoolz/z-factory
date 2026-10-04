# TASK-302 — Compact & Modular PLC Configuration

Status: **PLANNED**
Linear: pending

## Objective
Build a dynamic PLC creation/configuration UI driven by catalog metadata.

## Compact path
Built-in DI/DO/AI/AO, terminals/channels, electrical metadata, communication ports.

## Modular path
CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals.

## Acceptance criteria
- Incompatible modules cannot be selected.
- Expansion/slot limits enforced.
- Peripheral-to-channel type validation.
- Pin/channel visualization is data-driven.
- Configuration persists and reloads correctly.
- Unit/component tests cover both paths.
