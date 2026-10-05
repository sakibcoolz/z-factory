# ADR 0010 — In-Process Device Simulator and PLC Bridge

Status: Accepted — 2026-10-05 (implemented in TASK-204; accepted by the owner)

## Context
ADR-0005 decides that ordinary peripherals run in a shared device-simulator runtime, and ADR-0001 keeps the MVP a single Next.js application. TASK-204 had to decide where that runtime lives and how it exchanges values with OpenPLC.

Two facts about OpenPLC Runtime v4 (ADR-0009) constrain the exchange:

- Its Modbus server lets a client write coils and holding registers only. `%IX` and `%IW` (discrete inputs, input registers) are read-only from outside.
- The runtime can fill `%I` addresses itself only through plugins: a Modbus master that polls a field device, or the debugger's "force variable" channel (Socket.IO, addressed by STruC++ debug-table indexes).

## Decision
1. **Where it runs.** The device simulator is a module of the Next.js server process (`lib/runtimes/device-sim/`). One runtime object hosts the simulations of all factories; each factory has its own devices, PLC bridge and tick. No simulator container and no extra service.
2. **How it talks to a PLC.** A bridge per factory uses each PLC's published Modbus endpoint, the same one typed tag access uses. Per cycle it reads the tags PLC logic drives, advances the device models by the real elapsed time, and writes the feedback tags.
3. **Which tags.** A tag is wired to a device signal with `Tag.sourceDeviceInstanceId` + `Tag.sourceSignal`. A device signal can only be wired to a tag that is read-only for gateways and the UI (role other than `COMMAND` / `SETPOINT`), so nothing but the PLC program drives a device.
4. **Feedback addresses.** Simulated feedback is delivered to memory addresses (`%MX`, `%MW`, `%MD`). A feedback tag on `%I` or `%Q` is rejected.
5. **Operator actions.** Fault injection, fault clearing, device reset and forced sensor/switch values act on the simulated equipment through authenticated services and are always stored as events. They are not a gateway path.

## Consequences
- **Programs read feedback from `%M`, not `%I`.** A PLC program written for Z-Factory declares simulated sensor and status values as memory variables. That differs from a real installation, where field inputs arrive on `%I`. Hardware I/O points (`PlcIoPoint`, `%IX`/`%IW`) and their wiring stay valid as engineering documentation but are not what the running program reads for simulated devices. TASK-302 (tag and I/O generation) must take this into account.
- **Lifting that limit** means delivering values to `%I`: either through the runtime's debug force channel, or by running the simulator as a Modbus server the runtime's Modbus-master plugin polls. Both are additive behind the bridge's write interface. Either needs a new ADR.
- **Lifetime.** Simulations live in server memory. They stop when the server process stops and are not resumed automatically; device states are kept only as the last snapshot. Factory start/stop orchestration that restores them belongs to a later task.
- **One server process.** The shared runtime is a process-wide singleton. Running several server instances would run several simulators against the same PLCs; the MVP runs one.
- **Timing.** The cycle is 100 ms by default and best effort. One Modbus connection is opened per request. This is adequate for control-logic testing, not for timing analysis.
- **Phase 06.** The Go process-simulation service of ADR-0008 remains additive. The bridge and the signal-tag wiring are the contract it would reuse.
