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
Three.js via React Three Fiber. 3D is visualization, not the authoritative factory model. It consumes the same canonical runtime/device/tag/connection state as topology and live-tag views.

Every reusable generic catalog model may own a versioned GLB asset. The asset is generated/curated during authoring (TASK-403), stored under Z-Factory control, and reused by every factory instance of that catalog model. Opening a factory view must not call Meshy.

Catalog 3D coverage includes PLCs, VFDs/drives, servo drives, soft starters, controllers, motors, pumps, fans/blowers, conveyors, valves, sensors, switches, relays/contactors, encoders, remote I/O, gateways and future catalog peripherals.

Runtime styling is layered on top of the GLB rather than baked into it:
- RUNNING: green device outline/emphasis.
- FAULTED: red device outline/emphasis and affected connection lines red.
- DEGRADED/stale and DISCONNECTED use the existing warning/disconnected design semantics.
- Healthy active connections may be green/animated.
- State changes come from the same live event/telemetry stream as other runtime screens.

Process/module-specific 3D generation is not part of Phase 04. Module authoring will define its own UX later.

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
| 2i | PLC Program & Versions | `/factories/[factoryId]/plcs/[plcId]/program` (`?version=`), `/plcs/[plcId]/versions` |
| 2j | PLC I/O Mapping / Pinout | `/factories/[factoryId]/plcs/[plcId]/io-mapping` |
| 2k | Simulator / Debug | `/factories/[factoryId]/simulator` |
| 2l | Live Tags | `/factories/[factoryId]/tags` (`?plc=`) |
| 2m | Events / Alarms / Logs | `/factories/[factoryId]/events` (`?family=`, `?severity=`, `?device=`) |
| 2n | Runtime / Containers | `/factories/[factoryId]/runtime`, per PLC `/plcs/[plcId]/runtime` |
| 2o | 2D Network / Wiring Topology | `/factories/[factoryId]/topology` |
| 2p | PLC Export / Print | `/factories/[factoryId]/plcs/[plcId]/export`, `/export/report` (print) |
| 2q | 3D Factory View | `/factories/[factoryId]/view-3d` |

Screens 2a–2c and the factory overview/edit read the database (TASK-103), and so does 2e, the device catalog (TASK-301). For stored factories 2f, 2g, 2h and 2j read the database too (TASK-302), together with the PLC connections screen `/factories/[factoryId]/plcs/[plcId]/connections`, and so do 2d (designer) and 2o (topology) (TASK-303), 2p (export) (TASK-304) 2i, 2k and 2n (program, versions, simulator and runtime) (TASK-305), and 2l and 2m (live tags and events) (TASK-401). For the design fixtures, screens 2d and 2f–2q still read fixtures: `factory_001` (Pump House Demo, PLC `dev_001`) and, for 2g only, `factory_003`; they are reachable from the "Design fixtures" section of the factory explorer. Unknown IDs return the not-found screen.

### Live tags and events as built (TASK-401)
For a stored factory:

- **Live Tags** (`/factories/[factoryId]/tags`): every tag of the factory's PLCs with role, type, address, value, quality and how long ago it was confirmed. Values arrive over the live stream; the page is not reloaded. A pill shows the stream's state (live, reconnecting, paused, offline) and the number of tags per quality. Command and setpoint tags have a write control (Set ON / Set OFF, or a number field); every other tag says "read-only". After a write the row says that the PLC accepted the value and that PLC logic decides what follows; the result is then seen in the feedback tags. The side bar narrows the list to one PLC and shows each PLC's runtime state.
- **Events** (`/factories/[factoryId]/events`): the alarms (active first) with severity, what and where, when raised and cleared, their state (active or cleared, acknowledged or not) and an Acknowledge button; below, the recorded events, newest first, with new ones added on top as they are recorded. The side bar filters by event family and severity (with counts of the last 24 hours) and shows the retention. An alarm's device narrows the list to that device.
- **Staleness is shown, not hidden.** A value that has not been confirmed for the stale time, and every value while the stream is interrupted, is shown as stale in the warning colour with its age. A PLC that is not started has no values.
- **Other screens follow the stream.** The designer, the topology view and the runtime screens re-read their data when the factory records an event, instead of waiting for a poll. The simulator still polls every 2 seconds for its analogue values.
- A tab in the background closes its stream and resumes, without losing events, when it is shown again.

Differences from wireframes 2l and 2m:
- No trend sparklines and no Trends tab: telemetry is stored but not drawn yet.
- No free-text filter; filters are links.
- The write control is always visible on writable tags instead of an edit mode, and there is no separate "last write" panel: the result is shown in the row.
- No Logs tab: container logs are not delivered to the browser.
- Alarms and events are one screen; "Problems" is the alarm list.

### Program, versions, runtime and simulator as built (TASK-305)
For a stored PLC:

- **Program** (`plcs/[plcId]/program`): a Structured Text editor with line numbers. A PLC without a program opens with a starter program that declares every tag of the PLC as a located variable. Three actions: **Check** compiles without saving, **Save version** stores an immutable version, **Save & deploy** stores it and runs it on the started runtime. Compiler findings are listed with line and column; choosing one moves the cursor there. Beside the editor: runtime state, the latest versions (each opens in the editor with `?version=`) and the PLC's located variables.
- **Versions** (`plcs/[plcId]/versions`): every program version with status (draft, compiled, deployed, failed), which one is selected for the next start, and per version "Use for next start" and "Deploy now". Below, the configuration snapshot recorded at each deployment.
- **Runtime** (`plcs/[plcId]/runtime`): state read from the runtime when the page is opened, program, Modbus TCP endpoint, runtime version and image, and the operations Start, Deploy, Restart, Stop, Remove (asks first) and Refresh state. The last runtime events of the PLC are listed, failures included. The page re-reads itself every 5 seconds while a runtime exists.
- **Simulator** (`/factories/[factoryId]/simulator`, factory-wide): start and stop the device simulation; one card per simulated device with its command/setpoint signals (from PLC logic) and its feedback signals (from the simulator) kept apart, each with the tag it is wired to; per device, inject and clear its faults and reset it. Live values refresh every 2 seconds.
- **Factory runtime** (`/factories/[factoryId]/runtime`): the factory's PLCs with their last stored state, the simulation state and the Docker host status, linking to each PLC's Runtime screen.

Feedback for slow operations: while an operation runs, its button names it and counts the seconds, the other buttons are disabled and a line says why it can take minutes (image download, program build). The result or the reason for a failure appears under the buttons.

Differences from wireframes 2i, 2k and 2n:
- No syntax highlighting, no multiple program files and no debug console: one Structured Text program per PLC in a plain editor.
- Versions are a screen of their own. Rollback is "Deploy now" on an earlier version.
- The runtime screen is per PLC and shows the service name, never a container id; no CPU/memory figures and no container log viewer.
- The simulator shows every device as a card instead of one selected device, has no trend sparklines, and does not force sensor values (the service supports it; no control yet).
- No "Start factory": each PLC is started from its own Runtime screen and the simulation from the Simulator.

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
- No Start/Stop factory and no Export on the toolbar: a PLC is started from its Runtime screen and the simulation from the Simulator (TASK-305); export is on the PLC (TASK-304).
- No zones, layers or manual edge routing. Removing a wired edge disconnects the device from the PLC as a whole.
- The state overlay shows the stored state and is refreshed when the factory records an event (TASK-401).

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
- Section list of the PLC: Overview, Hardware, Connections and I/O Mapping are wired. Export is wired since TASK-304; Program, Versions, Runtime and Simulator since TASK-305. Live Tags and Events open the factory's screens narrowed to the PLC (TASK-401). Logs is listed but not wired.
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
