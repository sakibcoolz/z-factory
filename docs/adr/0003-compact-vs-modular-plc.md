# ADR-0003 — Explicit Compact vs Modular PLC Modeling

Status: Accepted

## Decision
Every PLC catalog model declares `COMPACT` or `MODULAR`.

Compact PLCs may expose documented built-in I/O directly.
Modular PLCs are configured through CPU + rack/backplane + slots + compatible modules, with I/O channels derived from installed modules unless the CPU itself documents onboard I/O.

## Consequences
Database, validation, forms, pin/channel visualization and runtime mapping must implement both paths explicitly.
