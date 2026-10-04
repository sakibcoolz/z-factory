# Project Status

Last architecture documentation update: 2026-10-04

## Current state
- Repository initialized on `develop`.
- Documentation-first foundation created.
- Primary database selected: PostgreSQL + Prisma.
- Core runtime selected: OpenPLC in reusable Docker containers.
- MVP protocol selected: Modbus TCP.
- Factory isolation rule defined: one Docker network per factory by default.
- Compact vs modular PLC model defined.
- Factory-specific industrial device instance/catalog model separation defined.
- Device simulation model defined for VFDs, motors, pumps, valves, sensors, switches and related devices.
- Gateway command path defined: gateway -> PLC command/setpoint -> PLC logic -> device simulation.
- Live-state vs persistence boundary defined.
- PLC engineering export/print requirement defined.
- Feature development: NOT STARTED.

## Planning gate
Phase task Markdown remains the execution unit. Linear synchronization is still blocked until a dedicated Z-Factory Linear project/team is selected or created.

## Next technical gate
Bootstrap the Next.js/Prisma foundation from Phase 01, then implement catalog/factory entities before Docker/OpenPLC runtime work.
