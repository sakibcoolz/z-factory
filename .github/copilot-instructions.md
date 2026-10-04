# GitHub Copilot Instructions — Z-Factory

Read and obey `AGENTS.md` and the active task under `docs/phases/**/tasks/`.

Architecture priorities:
- Next.js + TypeScript full-stack MVP.
- Server-only Docker orchestration.
- PostgreSQL + Prisma planned persistence.
- OpenPLC first runtime; Modbus TCP first protocol.
- React Flow for 2D topology.
- Three.js / React Three Fiber for 3D visualization.
- Compact PLC: built-in I/O and direct pin/channel view.
- Modular PLC: CPU + rack/backplane + slots + compatible modules + module channels.

Do not invent vendor specifications. Use normalized catalog data with source provenance.
Do not create a separate backend service unless an approved ADR changes the architecture.
