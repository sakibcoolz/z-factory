# TASK-405 — 3D Physical Conductor Rendering

Status: **DONE**
Linear: [ZFA-36](https://linear.app/recruit-verse/issue/ZFA-36)

## Objective
Render physical conductors in the 3D factory view from the canonical pin-to-pin wiring produced by TASK-307.

## User stories
- As a user, I see one clean logical connection in 2D but the actual individual conductors in 3D.
- As an engineer, I can visually understand which physical wires run between two catalog devices.
- As a user, I see runtime/fault state applied consistently to the physical conductors.

## Rendering rules
- 2D topology remains one logical edge between devices.
- 3D expands that logical edge into the physical conductor set defined by endpoint wiring metadata.
- Example: a three-phase VFD-to-motor power connection renders three thin conductors (for example L1/L2/L3 or U/V/W as defined by the catalog data), not one thick logical line.
- The same behavior applies to every supported catalog connection: PLC I/O, sensors, valves, relays/contactors, drives, motors, encoders, remote I/O, controllers, gateways and future catalog peripherals.
- Conductor count and labels come from persisted wiring; the renderer must not guess missing wires.
- Signal, feedback, power, common/ground, earth/shield and bus conductors are rendered only when explicitly modeled.
- Multiple wires sharing an allowed power/common/bus endpoint remain distinct conductor records.

## Runtime state
- Healthy active conductors may use the existing running/active visual semantics.
- A fault affecting a device or connection marks the affected conductor set red.
- Stale/disconnected semantics follow TASK-404.
- GLB assets are not regenerated to reflect wiring or state.

## Acceptance criteria
- A logical edge with N persisted conductors renders N thin 3D lines.
- VFD-to-motor three-phase wiring renders three distinct lines when three conductors are present.
- All catalog device combinations use the same generic conductor renderer.
- No physical wire is invented from device type alone.
- 3D reads TASK-307 canonical wiring and never owns a separate wiring map.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner, on 2026-10-06.

- **A logical edge with N persisted conductors renders N thin 3D lines.** `getFactoryScene` carries each wiring edge's stored wires as `conductors`; `lib/scene/conductors.ts` lays N lines side by side across the run (tested: three lines at −0.1, 0 and +0.1 m, the bundle turning with the run, one conductor on the line itself) and styles each kind (power heavier and solid, 0 V and earth dashed, bus as the network dash; tested). The canvas draws `Conductors` for a wiring edge and the old single `Connection` line for a relationship.
- **VFD-to-motor three-phase wiring renders three distinct lines.** The generic hardwired drive now has `U`, `V`, `W` power outputs and the generic three-phase motor `U`, `V`, `W` power inputs and `PE` (signal type `AC_400V`); the demo factory wires the three phases, and its topology shows the cable as one `WIRED_TO` edge with three `POWER` wires beside the `DRIVES` relationship (tested against PostgreSQL). In the browser (headless Chromium with WebGL, production build, a temporary factory that was removed afterwards) the drive-to-motor run showed the three phase conductors, the dashed earth conductor and the logical drives line, and the PLC-to-drive run its three signal conductors; the selected drive's panel read "4 conductors · U → U, V → V, W → W, PE → PE" and "3 conductors · DO Qa.0 → RUN, RUNNING → DI Ia.0, FAULT → DI Ia.1".
- **All catalog device combinations use the same renderer.** The renderer knows only `conductors` of a connection, whatever the devices are; the scene service test shows a PLC-to-valve wiring edge as three `SIGNAL` conductors and a motor-to-pump relationship as none.
- **No physical wire is invented from device type alone.** A conductor exists only for a stored wire: relationship edges carry `conductors: []` and are listed as "relationship, no conductor" (tested in the scene view).
- **3D reads the canonical wiring and owns no wiring map.** The scene is built from `getTopology`, whose wires come from the `DeviceConnection` rows of ADR-0014; nothing is stored for the 3D view.
- **Runtime state.** A conductor bundle takes the connection's appearance (red when either end is faulted, green and wider when both run, plain otherwise), the same rule as the logical line, which the scene view tests cover. In the browser check a fault was not shown red: the stored `FAULTED` state I set on the temporary motor was overridden by the live stream's `Stopped`, which is the stream's authority over stored state (TASK-404), not a conductor rule; a live fault was not exercised in the browser.
- **Tests:** 4 for the conductor layout and styles, 1 for the panel of the scene view, and the scene, demo, catalog and wiring suites changed for the conductors and the phase terminals; the suite went from 891 to 896 tests. Full run with `TEST_DOCKER=1`: 896 tests in 75 files pass. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass.

## Decisions made in this task
- **A relationship that is not wiring keeps its single logical line** (drives, measures, communicates with): it claims no conductor, and without it the scene would lose the link between a drive and its motor until the cable is wired.
- **Conductors lie on the floor in a flat bundle**, 7 cm apart, a hair above the logical line, spread across the run; no routing around devices.
- **Three phases are catalog data**: new signal type `AC_400V` and `U`/`V`/`W` terminals on the generic drive and motor only. Vendor PLC records are unchanged.
- **The demo factory wires its motor cable**, so the pump station shows three conductors out of the box.

