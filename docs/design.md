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

## Capability-driven device editor
Device detail navigation is generated from the exact catalog model's capabilities.

- PLC / programmable RTU: Overview, Hardware, I/O, Connections, Program, Versions, Communications, Runtime, Live Tags, Events.
- VFD / parameter-driven controller: Overview, Connections, Parameters, Registers, Runtime, Telemetry, Faults.
- Scriptable gateway/controller: Overview, Connections, Script, Versions, Communications, Runtime, Logs.

A Program tab is never shown just because an item is called a controller. The model must explicitly support programmable logic.

### Device screens as built (TASK-308)
A device that is not a controller has screens of its own at `/factories/[factoryId]/devices/[deviceId]`: Overview, Connections, and, by the capabilities of its exact model, Parameters, Registers and Communications; Runtime, Live Tags and Events link to the factory's screens. The section list is `deviceSections(model)`: a screen the model has no capability for is not listed. Controllers (PLC and the generic RTU) keep the PLC screens, whose Program and Versions sections appear from the `PROGRAMMABLE` capability. The factory overview and the designer's inspector link every device to its screen. The Parameters screen is a table of the behaviour model's parameters with unit, limits and default; "Save as new version" stores an immutable version and lists the versions below. No wireframe exists for these screens; they follow the PLC screens' conventions.

### Pin-to-pin wiring as built (TASK-307, ADR-0014)
The designer is the only screen that writes wiring.

- **Starting a wiring.** Drawing an edge between two devices that can be wired opens the wiring editor in the inspector for that pair. Nothing is stored by the gesture: a device is never wired because it was connected. Where a relationship is also possible (a drive drives a motor), the designer asks which is meant.
- **The editor** lists the wires between the two devices (`PT-101 / OUT → PLC-01 / AI 0`, with address and tag for a PLC channel) and offers one wire at a time: an endpoint of each device, described by what it is (`analog output · 0–10 V`, `supply output · 24 V DC`, `0 V / common`) and how many wires are on it. It suggests the first destination that is possible.
- **Blocked before saving.** A destination the rules refuse is marked "not possible"; choosing it shows the reason with both endpoints named and disables saving. The server checks again when the wire is stored, and its refusal is shown the same way.
- **Move and Remove** act on one wire. Moving starts from where the wire is; its own ends count as free while it is being moved, and the old wire stays until the new one is accepted.
- **One edge per pair.** However many wires two devices have, the canvas draws one `wired to · n wires` edge. Selecting it opens the editor; "Remove all wires" removes every wire of the pair, with PLC channels freed and their tags removed. A relationship that is not wiring keeps an edge of its own.
- **The read-only topology view** lists the wires of an edge pin to pin and offers no edit.
- **PLC screens.** Connections and I/O Mapping read the same wiring and have no form: the add-peripheral form of TASK-302 is gone.

No wireframe exists for the wiring editor; it follows the inspector's conventions.

TASK-405 (built) keeps 2D simple but expands each wiring edge in 3D to its persisted conductors: one thin line per stored wire, side by side between the two devices, drawn as its kind (power heavier, 0 V and earth dashed, a bus as the network dash) and coloured like the connection. A modeled three-phase VFD-to-motor cable (U/V/W, in the generic catalog since this task) renders three conductors; a relationship that is not wiring (drives, measures, …) stays one logical line and gets no conductor. The panel of a selected device lists its connections with their conductors. All catalog device combinations use the same renderer; nothing is drawn that is not stored.

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

Built in TASK-604 (see "Process modules as built" below) on the registry of TASK-605 (`getModuleIoRegistry`: rows with state BOUND / INVALID / UNBOUND and `blocking`, per-direction counts, per-PLC use, `readyToRun`; `listBindableTags`: every tag with its refusal, so the picker lists the free compatible ones and explains the rest). Trends/scenarios have no data yet and no section.

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

### Communication as built (TASK-704)
`/factories/[factoryId]/plcs/[plcId]/communication`, a "Communication" section of every PLC/RTU. No wireframe exists; it follows the PLC screens.

- **One card per link** the PLC takes part in, either role: `PLC-A supervises PLC-B`, a pill saying whether this PLC is the client or the server, disabled and quality pills (good / stale / disconnected while the factory runs), and one line tracing the path: `PLC-A (client) → Modbus TCP plc-b:502 unit 1 → PLC-B (server) · every 500 ms · version 4`. Below, whether the client's runtime runs this version of the link (in the fault colour when a deployment is due) and the monitor's reason.
- **Values table:** direction (`READ ← PLC-B`, `WRITE → PLC-B command`), the client's tag and located address, the server's tag, address and Modbus register, type and unit, interval, quality per value (paused when disabled); Pause/Resume and Remove on the client side. A line repeats that a WRITE reaches only the server's command and setpoint tags and the server's program decides, and links the link's JSON and the peer's Communication screen.
- **New value** (client side only): direction, then two tag pickers — the usable tags first, every other tag listed disabled under "not possible" with its reason (`program output: only a command or setpoint is written`, `already written by a link`, `a bit from a peer arrives in %IX`, …), as the wiring editor does; an optional own interval. Pair rules (type, scaling, unit) are checked when the value is added and shown under the form.
- **Link settings** (client side): relationship, poll interval, unit id, server port; Disable/Enable and Remove link (asks first). Every change says that the client's program has to be deployed to apply it.
- **New link:** the factory's other controllers (a model that does not serve Modbus TCP is marked), relationship, whether this PLC is the client or the server, poll interval.
- **Topology and designer:** a link is its own edge from client to server (`supervises · Modbus TCP · 3 values`); its inspector shows the link and opens the Communication screen. The canvas never removes or edits a link.
- The page refreshes every 3 s while the factory's links are watched.

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
| 2q | 3D Factory View | `/factories/[factoryId]/view-3d` (database) |
| — | External gateways | `/factories/[factoryId]/gateways` (database) |
| — | Process modules | `/factories/[factoryId]/modules`, per module `/modules/[moduleId]` (database) |
| — | PLC communication | `/factories/[factoryId]/plcs/[plcId]/communication` (database) |

Every screen reads the database: 2a–2c and the factory overview/edit (TASK-103), 2e the device catalog (TASK-301), 2f, 2g, 2h and 2j (TASK-302) together with the PLC connections screen `/factories/[factoryId]/plcs/[plcId]/connections`, 2d (designer) and 2o (topology) (TASK-303), 2p (export) (TASK-304), 2i, 2k and 2n (program, versions, simulator and runtime) (TASK-305), 2l and 2m (live tags and events) (TASK-401), 2q (3D view) (TASK-402), the device screens (TASK-308), and the process-module screens (TASK-604). The design fixtures of TASK-104 (`factory_001`, `factory_003`, PLC `dev_001`) were retired in TASK-309; an unknown id returns the not-found screen.

### 3D view as built (TASK-402)
For a stored factory, `/factories/[factoryId]/view-3d` shows a WebGL scene beside an inspector:

- **Scene:** a floor grid with every device of the factory where the designer has it (the designer's default spacing is 2 m). A device is drawn from the 3D asset of its catalog model, fitted into the space of its category, or as that category's generic shape while the model has no asset or the asset cannot be loaded. Above each device: its name and stored runtime state.
- **Connections:** one line on the floor per relationship between two devices, the same relationships and line styles as the 2D topology (solid signal, dashed network, dotted feedback).
- **Camera:** drag to orbit, scroll to zoom, right-drag to pan; buttons for an isometric, a top and a front view.
- **Inspector:** the list of devices, each marked "asset v<n>" or "placeholder". A device is selected in the scene or in the list. The selection shows type, model, role, state, asset and placing, with buttons to turn it by 45°, make it smaller or larger (×0.25 to ×4) and reset it, and links to the PLC's screens and the catalog model.
- **Without WebGL** the scene is replaced by a message; the list and the selection still work.
- The view re-reads its own data (the factory's overall state, the layout) when the factory records an event.

**Runtime state in the scene (TASK-404).** State is drawn around a device and along its connections, never into its model:

| State | Device | Text under the name |
|---|---|---|
| Running | green ring on the floor and green frame around the device | Running |
| Faulted | red ring that pulses, thicker red frame | Faulted |
| Degraded | amber ring and frame | Degraded |
| Not answering (a started PLC that Z-Factory cannot reach) | purple ring and frame | No answer |
| Starting, stopping | blue ring, no frame | Starting / Stopping |
| Stopped | nothing | Stopped |
| Not confirmed (the stream is interrupted, or has not reported the device) | amber, when the last known state was running, starting or stopping; a fault stays red; otherwise as last known | e.g. "Running · stale" |

Connections follow the rule of the 2D topology: red when either end is faulted, green with dashes flowing from source to target when both ends run, plain otherwise. A connection to a device that does not answer, or whose state is not confirmed, is never shown as active. Nothing else in the scene moves; when a fault or a lost confirmation ends the flow, the scene stands still.

The colours are the design system's state colours, the same as the state pills and the 2D topology. A pill in the corner of the scene says whether the state is live; the legend names the four colours. States arrive over the factory's live stream as the server works them out; the page is not reloaded for them. The device list and the inspector show the same state, and the inspector says where it comes from (simulator memory, last snapshot, last stored).

Differences from wireframe 2q:
- State is shown as a ring, a frame and a line colour around the device, not by recolouring the model: an asset is shared by all its instances and is not changed.
- Devices themselves do not move (no spinning rotor, no travelling valve): only connections flow and faults pulse.
- Positions are not edited here; the layout is the designer's. Only rotation and size are set in this view.
- No "external device" styling and no saved camera positions.
- A device is drawn from its catalog model's asset once one is authored (TASK-403); an installation without assets draws every device as a generic shape.

### Live tags and events as built (TASK-401)
For a stored factory:

- **Live Tags** (`/factories/[factoryId]/tags`): every tag of the factory's PLCs with role, type, address, value, quality and how long ago it was confirmed. Values arrive over the live stream; the page is not reloaded. A pill shows the stream's state (live, reconnecting, paused, offline) and the number of tags per quality. A "driven by" column names each tag's owner (program output, field input, simulated feedback, external command, program memory; ADR-0015, TASK-205). External command tags have a write control (Set ON / Set OFF, or a number field); every other tag says "read-only". After a write the row says that the PLC accepted the value and that PLC logic decides what follows; the result is then seen in the feedback tags. The side bar narrows the list to one PLC and shows each PLC's runtime state.
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
- **Factory runtime** (`/factories/[factoryId]/runtime`): the factory's PLCs with their last stored state, the simulation state and the Docker host status, linking to each PLC's Runtime screen. Since TASK-502 it has **Start factory** (every PLC runtime, then the device simulation, then the gateway endpoints) and **Stop factory** (asks first; simulation, then PLCs).

Feedback for slow operations: while an operation runs, its button names it and counts the seconds, the other buttons are disabled and a line says why it can take minutes (image download, program build). The result or the reason for a failure appears under the buttons.

Differences from wireframes 2i, 2k and 2n:
- No syntax highlighting, no multiple program files and no debug console: one Structured Text program per PLC in a plain editor.
- Versions are a screen of their own. Rollback is "Deploy now" on an earlier version.
- The runtime screen is per PLC and shows the service name, never a container id; no CPU/memory figures and no container log viewer.
- The simulator shows every device as a card instead of one selected device, has no trend sparklines, and does not force sensor values (the service supports it; no control yet).
- "Start factory" and "Stop factory" are on the factory's Runtime screen (TASK-502), not on the simulator; a single PLC is still started from its own Runtime screen and the simulation alone from the Simulator.

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
- No Start/Stop factory and no Export on the toolbar: the factory is started from its Runtime screen (TASK-502), a single PLC from its own Runtime screen and the simulation from the Simulator (TASK-305); export is on the PLC (TASK-304).
- No zones, layers or manual edge routing. Removing a wired edge disconnects the device from the PLC as a whole.
- The state overlay shows the stored state and is refreshed when the factory records an event (TASK-401).

### PLC configuration as built (TASK-302)
For a stored factory the wireframe's single wizard is split into steps that each save:

1. **Create** (`devices/new/compact|modular`): catalog model, instance name, process role. Reached from the factory overview, which lists the factory's devices.
2. **Hardware** (`plcs/[plcId]/hardware`): pin view drawn from the PLC's I/O points; selecting a pin (`?pin=`) shows its signal, program address, vendor address, tag and device. A modular PLC also shows its rack, its installed modules, and a form that offers only compatible modules and free slots.
3. **Connections** (`plcs/[plcId]/connections`): the devices wired to the PLC with terminal → channel → address → tag. Read-only since TASK-307: a projection of the factory's wiring with a link to the designer, where wires are made.
4. **I/O mapping** (`plcs/[plcId]/io-mapping`): every channel with program address, Modbus address, tag and device.

The factory overview lists the devices as they are connected (TASK-306). A PLC is a drop-down holding the devices connected to it, each under the device it is reached through (`PLC → drive → motor → pump`); a device appears once. A drop-down is closed at first and shows how many devices it holds and how many of them are faulted; "Expand all" and "Collapse all" open and close every one. A device with no way to a PLC is listed beside the PLCs, with what is connected to it below it. The hierarchy only reads the connections; they are changed in the designer and on the PLC screens.

Differences from wireframes 2f, 2g, 2h and 2j:
- No draft state and no "Next" step: each step is saved when submitted.
- The channel panel is read-only; wiring is done in the designer, pin by pin (TASK-307), not by editing a pin.
- Devices are placed in the designer and wired there; the Connections screen is a projection of that wiring (TASK-307).
- Section list of the PLC: Overview, Hardware, Connections and I/O Mapping are wired. Export is wired since TASK-304; Program, Versions, Runtime and Simulator since TASK-305. Live Tags and Events open the factory's screens narrowed to the PLC (TASK-401). Logs is listed but not wired.
- The Pump House Demo and the modular bench design fixtures are gone since TASK-309; "Create pump station demo" builds a stored factory instead (`docs/demo-runbook.md`).

### Gateways as built (TASK-501)
`/factories/[factoryId]/gateways`, reached from the factory overview and the runtime screen. No wireframe exists for it; it follows the shell's conventions.

- **Header:** what the screen is for in one paragraph (an edge device connects to an endpoint of this host, reads mapped tags, writes only command and setpoint tags, PLC logic decides) and "Add gateway". While only `127.0.0.1` is allowed, a note says that nothing outside this machine can connect and what to change.
- **Per gateway, per PLC connection:** the endpoint (`address:port`, unit id, expected read interval), a pill for the endpoint (open with the number of devices connected, open without a device, not open, closed), the PLC and its stored runtime state, request and refusal counters with the time of the last request, and the link to the register map. Actions: close or open the endpoint, map all tags, remove (asks first). A reason is shown when an endpoint could not be opened.
- **Mapped tags:** name for the gateway, tag, role, type, Modbus area and address (with the `40001`-style address), what the gateway may do (read, or read and write in the warning colour) and "Unmap".
- **Map a tag:** the unmapped tags of the PLC (those PLC logic produces are marked read only), access, an optional name for the gateway.
- **Connect to a PLC:** PLC, an address of this host from the allowed ones, port (a free one is suggested), unit id, read interval.
- The page refreshes every 5 seconds while an endpoint is open. Nothing on it writes a PLC tag.

### Process modules as built (TASK-604)
`/factories/[factoryId]/modules` (list and "New module") and `/factories/[factoryId]/modules/[moduleId]` (the editor), reached from the factory overview. No wireframe exists; they follow the shell's conventions and the device screens.

- **List:** module, type and version, profile, devices in roles, signals bound of consumed, a readiness pill (`ready to run`, or what is missing: issues, required unbound, invalid; `no process model` for a type without one) and the stored state.
- **New module:** type (the newest version of each installed type), name, location, the type's profiles when it has any, and the type's settings as fields with unit, limits and default. Changing the type changes the fields; nothing process-specific is in the form itself. A refused name or setting is shown under the form; success opens the editor.
- **Editor sections** (side bar, in the order of the UX above): Overview with four cells (profile, devices in roles, signals bound with required-unbound and invalid counts, process model and whether the bridge runs), settings (name, location, profile, the type's settings) and the module's issues; **Device roles** (role, the categories it takes, the devices in it with a link to each device's screen and Unassign, and a picker of the factory devices of a fitting category not yet in the role, disabled when the role is full); **Consumed PLC I/O** with totals per direction and per PLC, and the registry table: signal, direction and role, type and unit, state pill (`bound`, `invalid` with the reason, `required · unbound` in the fault colour, `optional · unbound`), the binding (PLC, tag, located address, type, scale, Modbus area and address) and the picker: free compatible tags first, every other tag disabled under "not possible" with the rule's reason and who holds it; Bind, or Move and Release for a bound signal; **Interlocks** (list with enable/disable/remove; a form for a one-condition interlock: code, name, severity, the output it blocks, the signal, operator by data type, value with unit); **Runtime** (Start/Stop process bridge for the factory, off until the module is ready or when the service is not configured; while running: quality pill, tick and simulated time, active alarms, and a table of live values per signal from bridge memory, refreshed every 2 s); **Topology** (an SVG of the module between its PLCs, each with the number of signals bound, and the devices in their roles; a required role without a device is drawn empty in the fault colour); **Export** (the `module-io.json` download and the import form, which replaces the bindings all or nothing).
- **Delete** sits in the side bar's danger zone and asks first; the module's devices and tags stay.
- Every write goes through the module service or the I/O registry; the screen offers only what they would accept and shows their refusal otherwise.

### 3D asset status in the catalog (TASK-403)
A catalog model's screen has a **3D asset** section: a pill with what is rendered and what is going on (`3D v2`, `generic shape`, `… · generating`, `… · generation failed`), a sentence saying whether instances are drawn from a version or as the generic shape of the category, and a table of the stored versions (version, state, source with the provider's task id, date, and a note: the provider's progress, the file size, or why it failed or was retired). In the model tree a model with an asset is marked `3D`, one being generated `3D …`, one whose last generation failed `3D failed`; the status bar counts the models with an asset. The screen has no control that generates, retires or uploads anything: it names the command (`npm run assets`).

### Device Catalog differences from wireframe 2e
- No "Use in factory" button: the catalog has no factory context; devices are created from the designer (TASK-302).
- No product photo: vendor imagery is not stored (source policy).
- The type filter and the model tree are links (`?type=`, `?model=`); there is no search box yet.
- The peripherals table lists every peripheral with whether it fits and why, not only the compatible ones.
- The source of each record is shown and linked.

### Create Factory differences from wireframe 2c
- The network name is `zfactory_<id>` and is assigned on create, so it is shown but not editable.
- No published-port field: published ports belong to runtime ports of devices (Phase 02).
- No template picker. One template exists since TASK-502: "Create pump station demo" below the form builds the MVP demo factory (`docs/demo-runbook.md`) and opens its Runtime screen. JSON import has no task yet.
- The submit button creates the factory and opens its overview; the designer for stored factories arrives with TASK-303.
- Host status shows only what is real today: PostgreSQL connected; Docker Engine and OpenPLC are marked "phase 02".

### Activity bar
FAC factories · CAT catalog · DSN designer (also PLC, topology, 3D, device configuration) · RUN runtime and simulator · TAG live tags · EVT events · EXP PLC export. Factory-scoped activities are disabled until a factory is open.


## Simulation test controls (Phase 08)
Simulator/debug UI will expose AUTO / MANUAL_OVERRIDE / SCENARIO for supported simulation inputs.

An input row shows effective value, unit, source mode, override action, clear action and validation state. PLC outputs remain read-only in this test surface. The screen makes it explicit that an overridden input can cause the PLC program to change outputs.

### Test inputs as built (TASK-802)
On a process module's editor, in the Runtime section, while the module runs in the process bridge: **Test inputs · values the PLC reads**, one row per INPUT signal the process model declares measured (`PUMP_HOUSE`: discharge pressure, valve open; `TANK`: level, high-level switch).

- **Value the PLC reads:** signal, name and the PLC tag it reaches.
- **Delivered:** the effective value with unit (on/off for a switch); under it `model: …` while an override replaces the calculated value.
- **Source:** `AUTO` (from the model), `MANUAL_OVERRIDE`, or `SCENARIO ramp a → b in n s`, with the simulated time it began and who set it.
- **Test control:** a manual value (or on/off for a switch) or a ramp (from, to, seconds), Override, and Clear (disabled while the value is AUTO). The server's refusal (`DISCHARGE_PRESSURE takes 0 to 12 bar`, a command, …) or its result (`the PLC now reads 3.5 bar; the model calculates 2.94`) is shown under the row.
- A warning above the table: changing a value here changes what the PLC program reads and may switch outputs, trip interlocks or raise alarms; only the simulation changes, the PLC's outputs stay read-only.
- The page refreshes every 2 s while the bridge runs, so the delivered value and the resulting PLC and device state (the live values table above) follow.

The browser calls a server action (`overrideAction`); only the server talks to the simulation service.

Closed-loop views must show command/setpoint separately from actual feedback.
