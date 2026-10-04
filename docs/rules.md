# Engineering Rules

1. Documentation-first; no undocumented feature implementation.
2. One Next.js application for MVP.
3. TypeScript strict mode.
4. Server/client boundaries must be explicit.
5. Docker orchestration is server-only.
6. Validate every user-supplied path, port, IP/subnet, image name, tag/address, and runtime option.
7. Do not pass arbitrary shell commands from UI to the host.
8. Prefer Docker Engine API through a maintained Node client; Docker Compose generation is an export/debug artifact, not the only orchestration mechanism.
9. OpenPLC is the first PLC runtime.
10. Modbus TCP is the first protocol.
11. Vendor PLC catalog != vendor firmware emulator.
12. Compact and modular PLC rules must be enforced in DB, API, and UI.
13. Persist vendor source provenance.
14. Avoid copying copyrighted vendor documentation/assets into the repo.
15. Every domain service has tests.
16. Runtime changes require integration tests where practical.
17. UI should not depend directly on Docker IDs; use internal device/runtime IDs.
18. Event payloads are versioned.
19. Never commit secrets or production credentials.
20. Keep task Markdown and Linear status synchronized.
21. Query Graphify before broad cross-module edits once generated.
22. Update Graphify after structural changes.
