# UX / Design Specification

## Core screens
1. Factories
2. Create Factory
3. Factory Designer
4. Device Catalog
5. Device Configuration
6. PLC Details / Edit PLC
7. PLC Program & Versions
8. PLC I/O Mapping / Pinout
9. Simulator / Debug
10. Live Tags
11. Events / Alarms / Logs
12. Runtime / Containers
13. 2D Network / Wiring Topology
14. PLC Export / Print
15. 3D Factory View
16. Process Modules (Phase 06+)
17. Process Module Details / I/O Mapping (Phase 06+)

## Factory Designer
Left palette: PLC, VFD/drive, servo drive, soft starter, controller, motor, pump, fan/blower, conveyor, valve, sensor, switch, relay/contactor, encoder, remote I/O, gateway.

Center: React Flow canvas.

Right inspector: selected device model, factory instance name/role, runtime state, connections, channel/tag/register mapping.

Top actions: Validate, Save, Start Factory, Stop Factory, Export.

## Device creation
User chooses reusable catalog model then creates a factory-specific instance with a unique name such as `VFD-01`, `MOTOR-01`, `PUMP-01`, `PT-101`, `LS-101`.

The UI should show only compatible and unoccupied PLC channels/protocol endpoints.

## PLC creation flow
Select manufacturer -> family -> exact model -> architecture -> role/name -> compatible peripherals -> I/O/tag/protocol mapping -> runtime config.

### Compact
Show power, built-in DI/DO/AI/AO, communication ports, visual pin/channel view, occupancy, tags, protocol config, connected devices.

### Modular
Show CPU -> rack/backplane -> slots -> compatible modules -> module channels/terminals -> occupancy -> tags -> connected devices.

The form must prevent incompatible modules, duplicate channel use, invalid signal types, and unsupported peripheral/channel combinations.

## PLC edit
Tabs/sections:
Overview, Hardware/Pinout, Rack & Modules, Connections, Program, I/O Mapping, Simulator, Live Tags, Events, Logs, Versions, Runtime, Export.

## Process module UX (Phase 06+)
Process modules are created from a module type and existing factory device instances. They do not add process-specific items to the generic hardware catalog.

Module editor sections:
- Overview / module type / instance name
- Assigned device roles
- Required and optional logical signals
- **Consumed PLC I/O Registry**
- PLC I/O/tag mapping
- Interlocks/validation
- Simulator/runtime state
- Trends/scenarios
- Export

The Consumed PLC I/O Registry shows each logical signal, direction, required/optional state, bound PLC/tag/I/O/register, engineering unit, quality and validation status. It also shows totals such as required inputs, optional inputs, required outputs, optional outputs, mapped and unmapped.

The mapping UI must show only compatible and available PLC endpoints, just like device wiring. Required unmapped signals block runtime start; optional signals do not.

## PLC-to-PLC communication UX (Phase 07)
PLC details gains a Communication section with:
- source/client PLC and target/server PLC
- protocol and endpoint
- local tag to remote register/tag mapping
- READ/WRITE direction
- polling/update interval
- data type/scaling
- connection health and stale/disconnected quality
- topology edge between PLCs
- validation and engineering export

The UI must not imply that a supervisory PLC bypasses the target PLC program. Writes are shown as target command/setpoint writes, after which target PLC logic decides the local output behavior.

## Device simulation UI
Show command/setpoint and actual feedback separately.

Examples:
- VFD: Run command, frequency setpoint, actual frequency, current, torque, status, fault.
- Motor: commanded/actual RPM, current, torque, temperature, status.
- Pump: run status, flow, pressure, fault.
- Valve: open/close/position command, actual position, end-switch feedback, fault.
- Sensor: current process value, unit, quality, simulated source/profile.

## Runtime state
Every device visibly shows: STOPPED, STARTING, RUNNING, DEGRADED, FAULTED, STOPPING, DISCONNECTED where applicable.

## Export
PLC details page exposes Print / Export:
- PDF-oriented engineering report
- CSV I/O/tag schedules
- JSON machine-readable configuration
- complete configuration package for reproducibility/import

Process-module export additionally contains module type/version, assigned roles, logical signals and the consumed PLC I/O registry.

## 3D
Three.js via React Three Fiber. 3D is visualization, not the authoritative factory model. It consumes the same canonical runtime/device/tag state as topology and live-tag views.

## Wireframe reference
Source: Claude Design project `2fc6a75c-7a5d-4a8c-a17c-17afa2d37f6c`, file `Z-Factory Wireframes.dc.html`, turn 2 (screens 2a–2q). Implemented by TASK-104 as a presentational shell over static fixtures (`lib/fixtures/`).

### Visual language
- VS Code-style dark shell: title bar with command center, activity bar, side bar, editor tabs, optional bottom panel, status bar.
- Type: Archivo for headings and body; system monospace for addresses, tags, values and logs. Zero corner radius.
- Tokens live only in `app/globals.css`: the Modernist design-system tokens (names unchanged) plus the dark-shell palette. UI code uses `var()`/theme utilities; raw hex and px literals in `app/` and `components/` fail lint.
- Modernist red (`--color-accent`) is reserved for faults and destructive actions. Blue is focus/primary, green running, amber degraded/stale, purple disconnected/external.
- The status bar colour follows the screen's worst condition: blue normal, amber degraded, red validation error/fault, purple no factory/draft.
- The export sheet is the one light surface (paper) and uses the Modernist light tokens.

### Screen → route map
| Wireframe | Core screen | Route |
|---|---|---|
| 2a | Factories | `/factories` (database) |
| 2b | First run / welcome | `/factories` while the owner has no factories |
| 2c | Create Factory | `/factories/new` (database) |
| — | Factory overview | `/factories/[factoryId]` (database) |
| — | Edit factory | `/factories/[factoryId]/edit` (database) |
| 2d | Factory Designer | `/factories/[factoryId]/designer` |
| 2e | Device Catalog | `/catalog` (`?model=`, `?type=`) |
| 2f | Device Configuration — compact | `/factories/[factoryId]/devices/new/compact`, then `/plcs/[plcId]/hardware` |
| 2g | Device Configuration — modular | `/factories/[factoryId]/devices/new/modular`, then `/plcs/[plcId]/hardware` |
| 2h | PLC Details / Edit | `/factories/[factoryId]/plcs/[plcId]` |
| 2i | PLC Program & Versions | `/factories/[factoryId]/plcs/[plcId]/program` |
| 2j | PLC I/O Mapping / Pinout | `/factories/[factoryId]/plcs/[plcId]/io-mapping` |
| 2k | Simulator / Debug | `/factories/[factoryId]/simulator` |
| 2l | Live Tags | `/factories/[factoryId]/tags` |
| 2m | Events / Alarms / Logs | `/factories/[factoryId]/events` |
| 2n | Runtime / Containers | `/factories/[factoryId]/runtime` |
| 2o | 2D Network / Wiring Topology | `/factories/[factoryId]/topology` |
| 2p | PLC Export / Print | `/factories/[factoryId]/plcs/[plcId]/export`, `/export/report` (print) |
| 2q | 3D Factory View | `/factories/[factoryId]/view-3d` |

Screens 2a–2c and the factory overview/edit read the database (TASK-103), and so does 2e, the device catalog (TASK-301). For stored factories 2f, 2g, 2h and 2j read the database too (TASK-302), together with the PLC connections screen `/factories/[factoryId]/plcs/[plcId]/connections`, and so do 2d (designer) and 2o (topology) (TASK-303) and 2p (export) (TASK-304). For the design fixtures, screens 2d and 2f–2q still read fixtures: `factory_001` (Pump House Demo, PLC `dev_001`) and, for 2g only, `factory_003`; they are reachable from the "Design fixtures" section of the factory explorer. Unknown IDs return the not-found screen.

### PLC export as built (TASK-304)
For a stored PLC the export screen shows the configuration revision, the program and mapping versions, download buttons (JSON, three CSV schedules), a switch to include the stored runtime status, and a preview of the whole report. "Open printable report" shows the report alone on a paper-like page with a print button.

Differences from wireframe 2p:
- No section picker: the report always contains all 15 sections.
- "Generate PDF" is the browser's print dialog on the report page, not a server-made file.
- No configuration package download.

### Designer and topology as built (TASK-303)
For a stored factory the designer (`/factories/[factoryId]/designer`) is a React Flow canvas with a palette and an inspector:

- **Palette:** every catalog model, by category, PLCs first. Dragging an item onto the canvas, or pressing its "+" button, creates a device instance with the next free numbered name (`VFD-01`). A PLC placed this way is a complete PLC with its I/O points or rack.
- **Canvas:** one node per device with its unique name, kind, model and runtime state. Dragging a node saves its position. Devices never placed are laid out on a grid.
- **Connecting:** draw from one device's handle to another. The relationship follows from the two devices and is stored in its own direction, whichever way it was drawn:

  | Devices | Result |
  |---|---|
  | PLC and a device with terminals | every terminal wired to a free compatible PLC channel, with tags (`CONTROLS` PLC → device, `FEEDS_BACK_TO` device → PLC) |
  | PLC and a protocol device | `COMMUNICATES_WITH` over the shared protocol |
  | drive and motor | `DRIVES` |
  | motor and motor-driven equipment | `MECHANICALLY_DRIVES` |
  | sensor or switch and another device | `MEASURES` |
  | controller, remote I/O, relay or contactor and another device | `CONTROLS` |

  When more than one applies, the canvas asks which. A connection the rules refuse (no free channel, wrong signal, a second motor on a drive, no relationship at all) is not created and the reason is shown.
- **Edges:** one edge per relationship between two devices, labelled with it and with the number of wires or the protocol. Solid: signal; dashed: network; dotted: feedback or measurement.
- **State overlay:** nodes show the stored runtime state; an edge is green and animated when both ends run and red when either end is faulted. While anything is running the view reloads every 5 seconds.
- **Inspector:** the selected device (rename, role, connections, delete with confirmation, link to a PLC's screens) or connection (wires, remove).

The topology screen (`/factories/[factoryId]/topology`) shows the same canvas read-only.

Differences from wireframes 2d and 2o:
- No Save or Validate button: every change is validated and saved when made.
- No Start/Stop factory and no Export on the toolbar: runtime control for stored factories is not wired (TASK-305), export is TASK-304.
- No zones, layers or manual edge routing. Removing a wired edge disconnects the device from the PLC as a whole.
- The state overlay uses the stored state, not a live stream (TASK-401).

### PLC configuration as built (TASK-302)
For a stored factory the wireframe's single wizard is split into steps that each save:

1. **Create** (`devices/new/compact|modular`): catalog model, instance name, process role. Reached from the factory overview, which lists the factory's devices.
2. **Hardware** (`plcs/[plcId]/hardware`): pin view drawn from the PLC's I/O points; selecting a pin (`?pin=`) shows its signal, program address, vendor address, tag and device. A modular PLC also shows its rack, its installed modules, and a form that offers only compatible modules and free slots.
3. **Connections** (`plcs/[plcId]/connections`): connected devices with terminal → channel → address → tag, and the catalog peripherals the PLC still has room for. "Add" (`?add=`) opens a form with a name and, per terminal, the free compatible channels.
4. **I/O mapping** (`plcs/[plcId]/io-mapping`): every channel with program address, Modbus address, tag and device.

Differences from wireframes 2f, 2g, 2h and 2j:
- No draft state and no "Next" step: each step is saved when submitted.
- The channel panel is read-only; wiring is done from Connections, not by editing a pin.
- Creating and connecting a peripheral is one action. Removing it deletes the device.
- Section list of the PLC: Overview, Hardware, Connections and I/O Mapping are wired. Export is wired too since TASK-304. Program, Simulator, Live Tags, Events, Logs, Versions and Runtime are listed but not wired for stored PLCs yet (TASK-305 proposed for Program, Versions, Runtime and Simulator; TASK-401 for Events and Live Tags).
- The Pump House Demo and the modular bench keep their fixture screens.

### Device Catalog differences from wireframe 2e
- No "Use in factory" button: the catalog has no factory context; devices are created from the designer (TASK-302).
- No product photo: vendor imagery is not stored (source policy).
- The type filter and the model tree are links (`?type=`, `?model=`); there is no search box yet.
- The peripherals table lists every peripheral with whether it fits and why, not only the compatible ones.
- The source of each record is shown and linked.

### Create Factory differences from wireframe 2c
- The network name is `zfactory_<id>` and is assigned on create, so it is shown but not editable.
- No published-port field: published ports belong to runtime ports of devices (Phase 02).
- No template picker: the demo template needs the verified catalog (TASK-301) and JSON import has no task yet. Factories start empty.
- The submit button creates the factory and opens its overview; the designer for stored factories arrives with TASK-303.
- Host status shows only what is real today: PostgreSQL connected; Docker Engine and OpenPLC are marked "phase 02".

### Activity bar
FAC factories · CAT catalog · DSN designer (also PLC, topology, 3D, device configuration) · RUN runtime and simulator · TAG live tags · EVT events · EXP PLC export. Factory-scoped activities are disabled until a factory is open.
