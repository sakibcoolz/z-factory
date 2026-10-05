# ADR 0014 — One Wire Between Two Exact Endpoints Is the Only Source of Wiring

Status: Accepted — 2026-10-06 (implemented in TASK-307; accepted by the owner)

## Context
Until TASK-307 a device was wired to a PLC as a whole. Adding a peripheral on the PLC's Connections screen, or drawing an edge in the designer, wired every terminal of the device to "the first free compatible channel" in one step, and removing the edge unwired the whole device. Two screens wrote wiring, both through the same automatic assignment. A person could not say "this terminal goes to that channel" in the designer, could not move one wire, and could not wire anything that is not PLC I/O: there were no supply, 0 V or earth terminals, and a signal between two devices could not be expressed.

TASK-307 asks for one authoritative pin-to-pin wiring workflow, validation before anything is saved, endpoints that may be shared where the catalog says so, and one source that tags, simulation, export, telemetry and 3D all read.

The data model already stored a wire as a `DeviceConnection` row between two endpoint references, and derived the tag from it. What was missing was not a store but the rules and the workflow around it. Three questions had to be answered:

- **Where do the rules of an endpoint come from?** They could be inferred from the category of a device, or stated per terminal in the catalog.
- **How is "one wire per signal, several per supply rail" enforced?** By database constraints per endpoint, or by the service with a lock.
- **What happens to the existing writers?** They could stay next to the new editor, or go.

## Decision
1. **A wire is one `DeviceConnection` between two exact endpoints**, and nothing else describes wiring. An endpoint is a terminal of a device (`DEVICE_IO`), an I/O point of a PLC (`PLC_IO_POINT`) or a communication port (`PROTOCOL_PORT`). Device-level relationships (`DRIVES`, `MEASURES`, …) are not wiring and keep the `DEVICE` endpoint.
2. **Endpoint metadata is catalog data.** A terminal has a kind (`SIGNAL`, `POWER`, `COMMON`, `EARTH`), a direction where it has one, a signal standard or supply voltage, and `maxConnections`. A port has protocols and `maxConnections`. A PLC channel is a signal endpoint that takes one wire. Nothing is inferred from the category or name of a device.
3. **One rule set decides every wire** (`lib/validation/wiring.ts`, pure): the two endpoints are on different devices, are of the same kind, have opposite directions where the kind has a direction, match in signal class and electrical standard, share a protocol if they are ports, are not already wired to each other, and each still has room. The refusal names both endpoints and the rule. The editor asks the same function for every pair of endpoints before anything is saved; the service asks it again inside the transaction that stores the wire.
4. **Sharing is explicit and counted.** An endpoint takes one wire unless the catalog gives it more. The shipped catalog does so for the terminals of a power supply (8), the common terminal of a drive (4) and communication ports (16). A shared endpoint is still checked like any other: a supply output feeds supply inputs of its own voltage only.
5. **Occupancy is enforced by the service under a lock.** A wire locks the two device rows, counts the wires on both endpoints and then writes. The exclusion constraints that already keep a PLC channel to one wire stay. A terminal id belongs to a catalog model, so an endpoint is only identified together with its device; a per-endpoint database constraint would need the limit copied onto every wire.
6. **Nothing is wired because two devices are connected.** Drawing an edge between two devices that can be wired opens the wiring editor for that pair and stores nothing. Every wire is added, moved or removed on its own. Moving a wire validates the new one first; the old one is removed and the new one written in one transaction, so a refused move changes nothing.
7. **A wire to a PLC channel still creates its tag** at the channel's address, and removing the wire removes the tag and frees the channel. Tags, the Modbus map, the simulator bridge and the export therefore keep reading what they read before.
8. **The designer is the only screen that writes wiring.** The PLC's Connections and I/O Mapping screens are read-only projections with a link to the designer. The add-peripheral form, its actions and the services behind it are removed.
9. **2D shows one logical edge per pair.** All wires between two devices are one `WIRED_TO` edge with the wires listed in the inspector; relationships that are not wiring keep an edge each.
10. **Stored relationships.** A wire between a PLC channel and a terminal keeps `CONTROLS` / `FEEDS_BACK_TO`, so existing rows need no migration. A link between two ports keeps `COMMUNICATES_WITH`. Every other wire (supply, 0 V, earth, a signal between two devices) is stored as `WIRED_TO`.

## Consequences
- **Wiring is a deliberate act.** A drive with seven signal terminals is seven wires, each chosen. The editor suggests the first possible destination, so a wire is usually two clicks, but there is no "wire everything" button.
- **Existing factories keep their wiring.** Stored rows are valid wires under the new rules and are shown as one edge per device pair. Nothing is rewritten.
- **A relationship may now need a choice.** Two devices that both have terminals can be related (a drive drives a motor) or wired. The designer asks which is meant where it used to connect at once.
- **The service function that builds a device with its wiring in one call stays** (`addPeripheral`), for the demo factory and for tests. It writes the same wires through the same per-wire function; no screen calls it.
- **Supply, 0 V and earth exist only where the catalog models them.** The generic catalog has a 24 V DC power supply and supply terminals on transmitters and the hardwired drive. Vendor PLC records have none: their supply terminals are vendor facts that have not been sourced.
- **Power and common wires are documentation.** The simulator does not check that a device is powered, and a signal wired between two devices is not simulated: the simulator still exchanges signals with PLC tags only.
- **Capacity is a number of wires.** Current consumption against a supply's rating is not modelled; the catalog has no such data for the generic models.
- **PLC-to-PLC channel wiring is refused.** Two PLCs exchange data through the protocol mappings of Phase 07.
- **3D can draw conductors from the same rows** (TASK-405): each wire names both of its ends.
