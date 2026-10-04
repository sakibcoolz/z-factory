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
| 2e | Device Catalog | `/catalog` |
| 2f | Device Configuration — compact | `/factories/[factoryId]/devices/new/compact` |
| 2g | Device Configuration — modular | `/factories/[factoryId]/devices/new/modular` |
| 2h | PLC Details / Edit | `/factories/[factoryId]/plcs/[plcId]` |
| 2i | PLC Program & Versions | `/factories/[factoryId]/plcs/[plcId]/program` |
| 2j | PLC I/O Mapping / Pinout | `/factories/[factoryId]/plcs/[plcId]/io-mapping` |
| 2k | Simulator / Debug | `/factories/[factoryId]/simulator` |
| 2l | Live Tags | `/factories/[factoryId]/tags` |
| 2m | Events / Alarms / Logs | `/factories/[factoryId]/events` |
| 2n | Runtime / Containers | `/factories/[factoryId]/runtime` |
| 2o | 2D Network / Wiring Topology | `/factories/[factoryId]/topology` |
| 2p | PLC Export / Print | `/factories/[factoryId]/plcs/[plcId]/export` |
| 2q | 3D Factory View | `/factories/[factoryId]/view-3d` |

Screens 2a–2c and the factory overview/edit read the database (TASK-103). Screens 2d–2q still read fixtures: `factory_001` (Pump House Demo, PLC `dev_001`) and, for 2g only, `factory_003`; they are reachable from the "Design fixtures" section of the factory explorer. Unknown IDs return the not-found screen.

### Create Factory differences from wireframe 2c
- The network name is `zfactory_<id>` and is assigned on create, so it is shown but not editable.
- No published-port field: published ports belong to runtime ports of devices (Phase 02).
- No template picker: the demo template needs the verified catalog (TASK-301) and JSON import has no task yet. Factories start empty.
- The submit button creates the factory and opens its overview; the designer for stored factories arrives with TASK-303.
- Host status shows only what is real today: PostgreSQL connected; Docker Engine and OpenPLC are marked "phase 02".

### Activity bar
FAC factories · CAT catalog · DSN designer (also PLC, topology, 3D, device configuration) · RUN runtime and simulator · TAG live tags · EVT events · EXP PLC export. Factory-scoped activities are disabled until a factory is open.
