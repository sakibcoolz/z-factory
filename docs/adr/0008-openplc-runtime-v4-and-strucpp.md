# ADR 0008 — OpenPLC Runtime v4 Image and the STruC++ Compile Step

Status: Accepted — 2026-10-05 (owner chose option A after the image research recorded in TASK-202)

## Context
ADR-0002 makes OpenPLC the first executable PLC runtime, and the architecture requires reusable, versioned runtime images. Two upstream facts shape how that is done:

- OpenPLC v3 (`thiagoralves/OpenPLC_v3`) was archived in April 2026 and never had an official image.
- OpenPLC Runtime v4 (`Autonomy-Logic/openplc-runtime`, MIT) is maintained and ships an official multi-arch image. It is headless (HTTPS REST API with JWT) and does **not** compile Structured Text: the OpenPLC Editor compiles ST to C++ with STruC++ and uploads the generated sources, which the runtime builds into a shared library and loads.

## Decision
1. **Runtime image.** Z-Factory runs the official `ghcr.io/autonomy-logic/openplc-runtime` image, pinned by tag and digest in the image allow-list (`lib/docker/runtime-images.ts`). Currently `v4.2.4@sha256:8412ffa8…fc4f`. No per-PLC image is built.
2. **Compile step.** Z-Factory compiles Structured Text itself with STruC++ (`Autonomy-Logic/STruCpp`, pinned to v0.7.0 from its GitHub release with an integrity hash) and composes the upload bundle the way the Editor does: generated sources and debug tables, the STruC++ runtime headers, `defines.h` with the program MD5, `c_blocks.h`, and `conf/modbus_slave.json`.
3. **Process boundary.** STruC++ is GPL-3.0-or-later. It runs only in a separate, short-lived Node.js process (`lib/runtimes/openplc/strucpp-worker.mjs`) that exchanges data over stdin/stdout. The server never imports it; a test enforces this.
4. **Control path.** The server talks to each runtime through its REST API, published on a loopback host port. Programs are uploaded through that API; nothing is bind-mounted or executed in the container.
5. **Tag access.** The runtime's Modbus slave plugin is enabled in every bundle on container port 502. Its address mapping is fixed by the runtime: `%QX` → coils, `%IX` → discrete inputs, `%IW` → input registers, `%QW` → holding registers, then the `%MW`, `%MD`, `%ML` memory segments.

## Consequences
- **Coupling to an editor-facing contract.** The bundle layout and the REST API are what the OpenPLC Editor uses, not a published integration contract, and the runtime releases often. The image digest and the STruC++ version are pinned together; upgrading either means rerunning the OpenPLC integration tests, which exercise the whole chain against the real image.
- **Licensing.** Distributing Z-Factory together with STruC++ carries GPL-3.0 obligations for that component. The process boundary keeps the server a separate work, but this is an engineering arrangement, not legal advice; review it before distributing.
- **Resources.** Each PLC container compiles its program with g++ and needs a 1 GB memory limit (256 MB is killed during the build). It idles at about 110 MB.
- **No real-time claim.** Containers run with all capabilities dropped, so the runtime falls back from SCHED_FIFO to default scheduling. Scan timing is best effort, consistent with the "no vendor timing" rule.
- **Runtime API trust.** The runtime generates a self-signed certificate at start, so the client does not verify it and refuses any non-loopback address. API credentials are derived per device from `RUNTIME_SECRET`.
- **Fallback.** If the v4 contract becomes unworkable, the alternative is a self-built image from the archived v3 source (MatIEC compile inside the container). That would need a new ADR.
