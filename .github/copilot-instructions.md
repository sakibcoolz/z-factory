# GitHub Copilot Instructions — Z-Factory

Read and obey `AGENTS.md` and the active task under `docs/phases/**/tasks/`.

Architecture priorities:
- Next.js + TypeScript full-stack MVP.
- PostgreSQL + Prisma persistence.
- Server-only Docker orchestration.
- OpenPLC first executable PLC runtime; Modbus TCP first industrial protocol.
- Reusable OpenPLC runtime images plus generated PLC-specific configuration/program/I/O/tag/Modbus maps.
- One isolated Docker network per factory.
- React Flow for 2D topology; Three.js / React Three Fiber later for 3D.
- Compact PLC: built-in I/O and direct pin/channel view.
- Modular PLC: CPU + rack/backplane + slots + compatible modules + module channels.
- Catalog model and factory instance are separate concepts.
- Gateways write PLC command/setpoint tags; PLC logic drives device simulators.
- Runtime is authoritative for live values; database persists configuration/history/important state.
- Shared simulator engines manage factory-specific VFD, motor, pump, valve, sensor and switch states.
- One VFD -> one primary motor for MVP.
- Every PLC supports engineering print/export.

Do not invent vendor specifications. Use normalized catalog data with source provenance.
Do not create a separate backend service unless an approved ADR changes the architecture.
