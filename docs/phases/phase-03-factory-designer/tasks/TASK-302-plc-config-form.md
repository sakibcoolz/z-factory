# TASK-302 — Compact & Modular PLC Configuration

Status: **DONE** — with one recorded deviation (see "Acceptance not fully met"), accepted by the owner on 2026-10-05
Linear: [ZFA-13](https://linear.app/recruit-verse/issue/ZFA-13)

## Objective
Build a dynamic PLC create/edit UI driven by catalog metadata, including factory-specific connected peripherals and I/O/tag/protocol assignments.

## Compact path
Built-in DI/DO/AI/AO, terminals/channels, electrical metadata, communication ports, occupancy and compatible peripheral picker.

## Modular path
CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals -> occupancy -> compatible peripheral picker.

## Acceptance criteria
- User creates a uniquely named PLC instance with separate process role.
- Incompatible modules cannot be selected.
- Expansion/slot limits enforced.
- Peripheral-to-channel signal/type compatibility validated.
- Occupied pins/channels cannot be double-assigned.
- Selected devices can be mapped to PLC pin/channel/tag/Modbus endpoints.
- Pin/channel visualization is data-driven.
- PLC edit view exposes overview, hardware, connections, program, I/O mapping, simulator, live tags, logs, versions, runtime and export.
- Configuration persists and reloads correctly.
- Unit/component tests cover both compact and modular paths.

## Evidence (2026-10-05)
- **Uniquely named PLC with a separate role.** `createPlc` and the create form (both architectures); a duplicate name is reported on the name field.
- **Incompatible modules cannot be selected.** The form lists only modules the catalog allows with the CPU; the service refuses any other.
- **Slot limits enforced.** Slots 1 to the rack's slot count (31 for the S7-1500 rail, 8 for the 5069-L306ER); an occupied slot is refused.
- **Signal and type compatibility validated.** A terminal is only offered, and only accepted on, a channel of the right point class that accepts its signal.
- **No double assignment.** An occupied channel is not offered and is refused if submitted; a failed wiring leaves no device behind.
- **Devices mapped to pin, channel, tag and Modbus endpoint.** Each wired terminal gets a tag at the channel's address, with its Modbus address in the register map; protocol devices are linked over a shared protocol.
- **Data-driven pin view.** Drawn from `PlcIoPoint` rows, for built-in I/O and for modules.
- **Persists and reloads.** A fresh database connection returns the same configuration.
- **Simulator picks the wiring up.** `planSimulation` finds a wired valve and its signals without further configuration.
- Tests: 7 address and naming unit tests, 12 component tests (both paths), 15 service tests and 5 server-action tests against PostgreSQL, plus 1 factory-page test. 428 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass. All screens were opened in a running build.

## Acceptance not fully met
- **"PLC edit view exposes overview, hardware, connections, program, I/O mapping, simulator, live tags, logs, versions, runtime and export."** Overview, Hardware, Connections and I/O Mapping are wired for stored PLCs. Program, Simulator, Live Tags, Events, Logs, Versions, Runtime and Export are listed in the section list but not wired. Their services exist (program versions, runtime lifecycle, simulation, tags). Program, Versions, Runtime and Simulator are proposed as TASK-305; Events and Live Tags belong to TASK-401 and Export to TASK-304.

## Decisions made in this task
- **I/O point addresses.** Inputs get memory addresses (`%MX`, `%MW`), outputs `%QX` / `%QW` (ADR-0010). Vendor terminal and address are shown beside them.
- **One action creates and wires a peripheral**; removing it deletes the device.
- **Tags of wired channels are read-only for gateways** (role STATUS, FEEDBACK or PROCESS_VALUE), so only the PLC program drives a device.
- **Analog tags** are INT16 with a default scale (0.01 for Hz, A and %, 1 for rpm, 0.1 otherwise). It is not derived from a signal range.
- **Rack slot count** counts module slots next to the CPU; the S7-1500 rail record was corrected from 32 to 31.

## Not in this task
- Devices that do not connect to a PLC (pump, fan, conveyor) cannot be created yet; they come with the topology (TASK-303).
- Editing a tag, moving a module to another slot, and rewiring a device without removing it.
- Register mapping for protocol devices.
- Expansion modules for compact PLCs.
