# Engineering Rules

1. Documentation-first; no undocumented feature implementation.
2. One Next.js TypeScript application for MVP.
3. PostgreSQL + Prisma are the primary persistence layer.
4. TypeScript strict mode.
5. Server/client boundaries must be explicit.
6. Docker orchestration is server-only.
7. Validate every user-supplied path, port, IP/subnet, image name, tag/address, register mapping and runtime option.
8. Do not pass arbitrary shell commands from UI to the host.
9. Prefer Docker Engine API; Compose generation is export/debug/reproducibility support, not the only orchestration mechanism.
10. OpenPLC is the first executable PLC runtime.
11. Modbus TCP is the first industrial protocol.
12. Vendor PLC catalog != vendor firmware emulator.
13. PLC identity is manufacturer/family/model; process role is separate.
14. Compact and modular PLC rules must be enforced in DB, API and UI.
15. Catalog model != factory device instance.
16. Factory device instance names are unique within a factory.
17. Every device connection must resolve to valid, compatible and available endpoints.
18. The gateway writes PLC command/setpoint tags; it never directly mutates downstream simulator state.
19. Command/setpoint values and actual feedback/status values must be distinct.
20. Runtime is authoritative for live state; database persists durable configuration/history/snapshots.
21. Do not write every PLC scan/simulator tick to PostgreSQL.
22. Shared simulator engines are preferred for simple peripherals; do not create one container per sensor/valve/motor/VFD by default.
23. MVP VFD invariant: one VFD instance -> one primary motor.
24. Device simulation must be explicit and testable; do not present approximations as full physics.
25. Every PLC instance supports engineering print/export.
26. Persist vendor source provenance and verification metadata.
27. Never invent vendor specifications, I/O counts, pinouts or register maps.
28. Avoid copying copyrighted vendor documentation/assets into the repo.
29. Every domain service has tests.
30. Runtime/protocol/simulator changes require integration tests where practical.
31. UI should not depend directly on Docker IDs; use internal device/runtime IDs.
32. Event payloads are versioned.
33. Never commit secrets or production credentials.
34. Keep task Markdown and Linear status synchronized.
35. Query Graphify before broad cross-module edits once generated.
36. Update Graphify after structural changes.
