# ADR-0025 — The Catalog Device Runtime Lives in the Simulation Service

Status: **ACCEPTED** (TASK-1009, 2026-10-11)

## Context
Phase 10 expands device simulation from the ten generic behaviours the server runs in its own process (ADR-0010, `lib/runtimes/device-sim`) to the whole catalog: every catalog model declares what the Go simulator can do for it, and the behaviour of a device is selected from that metadata, not from conditions in the UI. ADR-0008 already placed deterministic tick loops for many instances in `services/process-sim`, the Go service that hosts the process modules. The question of TASK-1009 was where the device runtime goes and how much of today's behaviour it ships with.

## Decision
1. **One simulation service.** The catalog device runtime is part of `services/process-sim`: the same binary, token, port, container and compose entry. Device factories get their own additive API family (`/v1/factories/{factoryId}`, `/v1/profiles`) beside the process-module contract, which does not change (`/v1/instances`, contract version 1). One service, many instances, as ADR-0008 says; no second token or client to operate.
2. **Behaviour profiles are the contract.** A profile is the documented generic behaviour of one device category: its key and version, signals (direction, kind, unit), faults (severity, latching, silent), links to other devices by role, parameters with defaults, states, and whether a tester may force its value. The service describes every profile over the API; Z-Factory names the profile of a device from the catalog's simulation metadata (`DEVICE_PROFILES` in `lib/domain/process-sim.ts`, keyed by the category's `simulatorType`), never from UI code. TASK-1010 formalises the catalog side of this contract.
3. **Parity first, then the catalog.** TASK-1009 ports the ten behaviours of the server's simulator (VFD, motor, pump, fan, conveyor, mixer, compressor, valve, sensor, switch) value for value, including the seeded random source and the fault, trip and reset rules, and proves it against the TypeScript engine. TASK-1011 adds the remaining catalog categories; TASK-1015 switches factories from the server's simulator to the service.
4. **Isolation is the runtime's job.** Each factory ticks on its own goroutine; a factory cannot stall another. Within a factory, a behaviour that panics is FAULTED and one that overruns its step budget too often is QUARANTINED: both are skipped with frozen outputs and BAD quality until configured again, while the other devices go on. The runtime bounds devices per factory and in total, keeps a fixed number of events per factory, and reports factories that stopped ticking as stalled.
5. **The PLC stays the authority.** Devices take inputs the PLC drives and produce feedback the PLC reads; the runtime never sets a PLC output, and forcing is confined to sensors and switches (ADR-0015).

## Consequences
- `docs/process-simulation.md` documents the device contract, the routes and the limits beside the process-module contract. The service's health and metrics carry both.
- `PROCESS_SIM_MAX_DEVICES` (default 2048) joins `PROCESS_SIM_MAX_INSTANCES` in the environment contract.
- The server keeps its own device simulator until TASK-1015; `lib/runtimes/process-sim/devices.ts` turns its configuration into the runtime's, so both read one source.
- Determinism holds for healthy devices: the same configuration, inputs and steps give the same outputs. Quarantine depends on the host's speed and is reported, never silent.
