# TASK-307 — Pin-to-Pin Wiring Editor & Validation

Status: **DONE**
Linear: [ZFA-34](https://linear.app/recruit-verse/issue/ZFA-34)

## Objective
Replace the PLC-centric compact mapping workflow with one authoritative pin-to-pin wiring workflow in the Phase 03 Factory Designer.

## User stories
- As a factory designer, I can connect an exact device pin/terminal to an exact compatible PLC or device pin.
- As a user, I see why a proposed connection is invalid before it is saved.
- As a user, I can edit, disconnect and reconnect a wire without creating duplicate mappings.
- As an engineer, I can trust that saved wiring is reused by OpenPLC mapping, simulation, export, telemetry and 3D.

## Rules
Each connectable endpoint carries engineering metadata: endpoint role, direction, signal class, electrical standard/range, protocol/port type, occupancy and sharing policy.

Default behavior:
- DI/DO/AI/AO and other signal endpoints allow one active connection.
- A second connection to an occupied signal endpoint is rejected.
- Power distribution, 0V/COM, PE/earth and supported bus endpoints may allow multiple connections only when catalog metadata explicitly marks them shareable.
- Shared endpoints must still honor electrical compatibility and capacity limits.
- Validation rejects incompatible direction, signal class, voltage/current standard, protocol, duplicate wiring and occupied endpoints.
- Error messages name both endpoints and the failed rule.

## 2D UX
2D topology stays intentionally compact:
- one logical edge between connected devices;
- selecting an edge reveals its physical pin/terminal mappings;
- pin-level edit mode exposes exact source and destination endpoints;
- incompatible destinations are blocked with an alert/error;
- invalid wiring is never persisted.

The system must not auto-wire every terminal merely because two device nodes are connected.

## Canonical mapping
Persisted physical wiring is the single source of truth.

Example:
`PT-101 / OUT+ -> PLC-01 / Slot-2 / AI-Module-01 / AI2`

Existing TASK-302 Connections/I/O Mapping views become read-only projections or are retired after migration. They must not remain a second writable mapping source.

## Acceptance criteria
- Exact endpoint-to-endpoint wiring persists and reloads.
- Wrong pin/type/direction/range connections are rejected before save.
- Occupied signal endpoints reject a second wire.
- Explicitly shareable 24V, 0V/COM, PE/earth and supported bus endpoints can accept multiple wires within defined limits.
- Edit/reconnect preserves the old connection until the replacement validates.
- 2D shows one logical edge per device relationship and exposes physical mappings in the inspector/edit mode.
- OpenPLC mapping, simulation, export, telemetry and Phase 04 3D consume the same canonical wiring.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner together with ADR-0014, on 2026-10-06.

- **Exact endpoint-to-endpoint wiring persists and reloads.** `connectWire` stores one `DeviceConnection` between two endpoints (`{ deviceId, type, id }`); `getPairWiring` reads it back with both ends by name, its tag and its address. Tested against PostgreSQL: `PT-101 / OUT → PLC-01 / AI 1` is stored with exactly those references, the channel is occupied and carries the tag `PT_101_OUT`.
- **Wrong pin, type, direction or range is rejected before save.** One pure rule set (`lib/validation/wiring.ts`) refuses a wire and names both endpoints and the rule, for example `PT-102 / OUT is 4–20 mA; PLC-01 / AI 0 takes 0–10 V.` The editor gets the refusal for every pair of endpoints before anything is saved and disables saving; the service applies the same function inside the transaction. Tested: signal standard, digital against analog, output to output, input to input, a supply terminal on a signal channel, two endpoints of one device; nothing is stored, no tag, no occupied channel.
- **An occupied signal endpoint rejects a second wire.** `wire-occupied`: "PLC-01 / DI … already has its wire, to LS-1 / OUT." Both the channel and the device's own terminal are single. Of four wires aimed at one channel at the same time, one is stored.
- **Shareable endpoints take several wires within their limit.** Terminals have a kind (`SIGNAL`, `POWER`, `COMMON`, `EARTH`) and `maxConnections`; ports have `maxConnections`. The generic power supply feeds eight transmitters and refuses the ninth ("PS-01 / +24V already has 8 of the 8 wires it takes."); 0 V to 0 V and earth to earth are wired; a supply terminal on a 0 V terminal and earth on common are refused; a second supply on a device's supply input is refused. Ten wires at once onto the 8-wire terminal store eight (the test fails without the row lock).
- **Edit and reconnect keep the old wire until the replacement validates.** `reconnectWire`: a refused move leaves the wire, its tag row and its channel identical; an accepted one leaves one wire and one tag at the new channel and frees the old one, in one transaction (tested).
- **2D shows one logical edge per pair.** `getTopology` returns one `WIRED_TO` edge for all wires between two devices with each wire pin to pin; the inspector lists them and opens the editor. The demo factory now reads `PLC-01 wired to VFD-01` (7 wires) and `PLC-01 wired to PT-101` (1 wire) where it had four PLC edges.
- **Nothing is wired by connecting two nodes.** `linkDevices` answers `WIRE` for two devices that are to be wired and stores nothing (tested: no connection, no tag, no occupied channel).
- **One source for the consumers.** A wire to a PLC channel still creates its tag through the same function as before, so the Modbus map, the simulator plan, the PLC export and the PLC screens read the same rows: tested on the wired transmitter (`getPlcConfiguration`, `planSimulation`, `getTopology`) and by the unchanged simulation, export and end-to-end suites, including a real OpenPLC runtime.
- **The PLC screens no longer write wiring.** Connections is a read-only projection with a link to the designer; the add-peripheral form, its two server actions and the services behind it (`wireExistingDevice`, `listAddablePeripherals`, `getPeripheralOptions`, `removePeripheral`) are removed. A test checks that the PLC screens have no action that wires.
- **In a browser** (headless Chromium, production build, a temporary factory that was removed afterwards): selecting a wiring edge showed its wire with address and tag and the editor; choosing `+24V` against `0V` showed "PS-01 / +24V is a supply terminal and PT-101 / 0V is a 0 V terminal; …" with saving disabled; adding `0V → 0V` stored the wire and the edge changed to "wired to · 2 wires". Not exercised in the browser: drawing an edge by dragging (the answer to it is covered by tests), and Move/Remove (component and database tests).
- **Tests:** 39 in three new suites (18 wire rules, 11 wiring service against PostgreSQL, 10 wiring editor), and the topology, PLC configuration, catalog, demo and canvas suites were changed to the new behaviour; tests of the removed form and actions were deleted. The suite went from 835 to 873 tests. Full run with `TEST_DOCKER=1`: 873 tests in 71 files pass. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass.

## Decisions made in this task
- **ADR-0014 (accepted):** one wire between two exact endpoints is the only source of wiring; rules are catalog data per endpoint; occupancy is enforced by the service under a lock; the designer is the only writer.
- **Schema (forward migration `endpoint_wiring`):** `DeviceIoDefinition.kind` and `.maxConnections`, `CommunicationPort.maxConnections`, relationship `WIRED_TO`, two CHECK constraints. Existing rows need no data migration.
- **Existing PLC wires keep their relationship** (`CONTROLS` / `FEEDS_BACK_TO`); supply, 0 V, earth and device-to-device signal wires are `WIRED_TO`.
- **Catalog:** new category `POWER_SUPPLY` with a generic 24 V DC power supply; supply terminals on the generic transmitters; `COM` and `PE` on the hardwired drive. Vendor PLC records get no supply terminals (unsourced vendor facts).
- **No "wire everything" action.** The editor suggests the first possible destination instead.
- **`addPeripheral` stays as a service** for the demo factory and tests; it writes the same wires through the same per-wire function and no screen calls it.
- **Drawing between two devices with terminals may now ask** whether a relationship or wiring is meant (for example drive → motor).
- **Not modelled:** current capacity of a supply (the limit is a number of wires), whether a device is powered, simulation of a signal wired between two devices, PLC-to-PLC channel wiring (refused; Phase 07).
- **Development database:** the migration is applied and the catalog seeded (the new category, model and terminals). The new power supply model has no 3D asset; it is drawn as a generic shape until one is generated.

