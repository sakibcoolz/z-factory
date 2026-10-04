# TASK-202 — OpenPLC Runtime Adapter

Status: **DONE**
Linear: [ZFA-9](https://linear.app/recruit-verse/issue/ZFA-9)

## Objective
Implement the OpenPLC runtime adapter using a reusable versioned image plus generated PLC-specific configuration, program, I/O/tag and Modbus mapping artifacts.

## Required behavior
Create, configure, attach network, start, stop, restart, remove, inspect, health-check, deploy/reload program, read/write tags, and capture runtime metadata.

## Acceptance criteria
- Program deployment/version is explicit.
- Program edits can redeploy/reload without rebuilding the base image.
- I/O/tag/Modbus mapping versions are recorded.
- Runtime failures become domain states/events.
- PLC hardware profile remains distinct from OpenPLC runtime identity.
- No claim of exact vendor firmware/timing.
- Integration test demonstrates OpenPLC startup, program execution, health and tag access.

## Image research (2026-10-05)
Checked against the upstream repositories and by running the image locally.

- **OpenPLC v3** (`thiagoralves/OpenPLC_v3`, GPL-3.0) was archived in April 2026. It has no official image; it compiles `.st` with MatIEC inside the container and has a built-in Modbus TCP server.
- **OpenPLC Runtime v4** (`Autonomy-Logic/openplc-runtime`, MIT) is maintained: v4.2.4 on 2026-09-23, official multi-arch image `ghcr.io/autonomy-logic/openplc-runtime`. It is headless: an HTTPS REST API on 8443 with JWT (create user, login, upload program, compilation status, start/stop, status, logs), a WebSocket debug interface, and Modbus slave/master, OPC UA and S7comm plugins.
- v4 does **not** compile Structured Text. The OpenPLC Editor compiles ST to C++ with STruC++ (`Autonomy-Logic/STruCpp`, GPL-3.0-or-later, TypeScript, Node >= 22, v0.7.0) and uploads a bundle of generated sources; the runtime builds a shared library from it.

Verified locally with `ghcr.io/autonomy-logic/openplc-runtime:v4.2.4` (digest `sha256:8412ffa8…fc4f`; about 359 MB to pull, 1.42 GB on disk):
- Runs under the TASK-201 hardening (all capabilities dropped, `no-new-privileges`, no volume, 256 MB, 1 CPU): API up in about 6 s, about 110 MB memory, 11 processes. The extra capabilities and volume in the upstream quick start are not required to start.
- The API flow works without the Editor: create user, log in, upload a zip, poll compilation.
- A bundle made with the STruC++ CLI (`generated.cpp`, `generated.hpp`, `strucpp_runtime/include/`, plus a hand-written `defines.h` with `PROGRAM_MD5`) **compiles** on the runtime but **does not load**: the shared library lacks the debug tables (`strucpp::debug::debug_array_count`) that the Editor produces through the STruC++ library API (`debug-table-gen`, `compose-runtime-v4-bundle.ts` in the editor repository). The CLI's `--debug` flag does not emit them.

Decision (2026-10-05): the owner chose the official v4 image with a spike first. The spike succeeded, see below; ADR-0008 records the decision.

## Spike result (2026-10-05)
The missing piece was the compile path: the OpenPLC Editor does not use the STruC++ CLI but its library API (`compile` with `debug: true`, an MD5 and the standard libraries), which also emits `generated_debug.cpp`. Reproducing that call and the Editor's bundle layout (`composeRuntimeV4Bundle`) gives a program that builds, loads and runs. Two more findings:

- The runtime's g++ build is OOM-killed at 256 MB; PLC containers get 1 GB.
- Adding `conf/modbus_slave.json` enables the Modbus TCP server; reads and writes work and the located-variable mapping is fixed by the runtime.

## Evidence (2026-10-05)
- **Explicit versions.** `createProgramVersion` stores immutable versions with a SHA-256 checksum; deployment marks exactly one `DEPLOYED`.
- **Redeploy without rebuilding the image.** Integration test: a second version is deployed into the same container; container id and image id are unchanged and the new logic is observed over Modbus.
- **Mapping versions recorded.** Each deployment writes a `ConfigurationVersion` snapshot with the program version, checksum, MD5, compiler, I/O and Modbus mapping versions, runtime and image digest.
- **Failures become states and events.** A non-compiling program → version `FAILED`, `PLC_PROGRAM_DEPLOY_FAILED`, PLC keeps running; a killed container → device `FAULTED`, `DEVICE_FAULTED`, factory `DEGRADED`.
- **Profile vs runtime identity.** Runtime recorded as `OpenPLC Runtime v4.2.4` plus image digest on `PlcInstanceProfile`; the hardware profile stays on the catalog model. No vendor or real-time claim (ADR-0008).
- **Integration tests against the real runtime** (gated by `TEST_DOCKER=1`): startup under the hardened settings, program execution (scan counter advances at the task rate), health, tag access over Modbus, PLC logic deciding the device command through an interlock, read-only areas refused, restart, stop, remove. Adapter: 7 tests. Service with PostgreSQL: 9 tests.
- **Unit tests** (23): compiler success and diagnostics, bundle layout, zip round trip, credentials, loopback-only client, state mapping, service names, Modbus client against a fake server; server-only and "STruC++ only in the worker" checks.
- 243 tests pass with the database and Docker tests enabled; the host had the same containers and networks before and after. Format check, lint, typecheck and build pass. CI runs the OpenPLC tests too (`TEST_DOCKER=1`).

## Not in this task
- No screen calls the runtime services yet (Program, PLC overview and Runtime screens still render fixtures).
- Typed tags, generated I/O and Modbus maps, and restricting writes to command/setpoint tags: TASK-203.
- Device simulation and the feedback loop: TASK-204.
- TLS verification of the runtime API (loopback only today) and a production secret store.
