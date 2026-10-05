# TASK-306 — Factory Overview Device Hierarchy

Status: **DONE**
Linear: [ZFA-33](https://linear.app/recruit-verse/issue/ZFA-33)

Requested by the owner on 2026-10-06 as a follow-up to the factory overview (TASK-103, TASK-302).

## Objective
Show the devices on the factory overview as a hierarchy of how they are connected instead of a flat list: a PLC is a drop-down that holds the devices connected to it.

## Scope
- A pure rule that turns a factory's devices and connections into a tree: PLCs as roots, every device once.
- A service that returns the tree for a factory.
- The factory overview table: a device with others below it opens and closes; "Expand all" and "Collapse all".
- Tests and documentation.

## Prerequisites
TASK-302 (devices of a factory), TASK-303 (connections), TASK-501 (gateway connections).

## Out of scope
Changing connections from this screen; the designer, topology and 3D views; any schema change.

## Acceptance
- A PLC connected to several devices lists them under its drop-down; closed, it shows how many it holds.
- Every device of the factory appears exactly once.
- Devices not connected to a PLC stay visible.
- A PLC still links to its screens; type, model, role and state are shown for every device.

## Decisions made in this task
- **The hierarchy is a reading of the connections.** It is built from `DeviceConnection` rows and gateway connections each time the page is loaded. Nothing is stored, and no connection rule changes.
- **Nearest PLC, shortest way.** A device hangs below the PLC it is nearest to, under the device it is reached through: `PLC → drive → motor → pump`. A device wired to the PLC itself is listed directly under the PLC.
- **A `MEASURES` connection is weak.** It places a device only when nothing else does, so a pump stays in its drive chain and is not listed under the transmitter that measures it.
- **Devices without a way to a PLC are roots of their own.** A drive with its motor that is not connected to a PLC is a drop-down beside the PLCs; a device connected to nothing is a plain row. Hiding them would hide exactly the devices that still need connecting.
- **Closed by default.** A closed drop-down shows how many devices it holds and how many of them are faulted. Only the top level opens and closes; the levels below are indented.
- **Open state is not stored.** It lives in the page and is gone after a reload.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner, on 2026-10-06.

- **A PLC lists its devices under a drop-down.** `buildDeviceTree` (`lib/domain/device-tree.ts`) makes the tree, `getFactoryDeviceTree` returns it for a factory, and `components/factories/device-tree.tsx` renders it. Component tests: every PLC starts closed with its count ("4 devices"), opens to its devices indented by depth, closes again; "Expand all" and "Collapse all" act on every drop-down; a closed PLC says when a device below it is faulted.
- **Every device appears once.** Unit tests cover a device connected twice, a gateway shared by two PLCs, two PLCs connected to each other, and devices connected in a ring. Against PostgreSQL the demo factory reads as `PLC-01(GATEWAY-01, PT-101, VFD-01(MOTOR-01(PUMP-01)))`: the pump stays in its drive chain although the transmitter measures it.
- **Devices not connected to a PLC stay visible.** They are roots of their own (tested: a loose transmitter beside the demo PLC; a drive with its motor as a drop-down of its own).
- **Links and columns are kept.** A PLC links to its screens; type, model, role and state are shown for every device (tested).
- **In a browser** (headless Chromium against a production build, read-only, on the owner's factory page): closed, the page showed the PLC with its device count and two drives that are not connected to the PLC as drop-downs of their own; after "Expand all" each showed its devices indented below it. Nothing was created or changed. Levels deeper than one were seen in the component tests only, not in the browser.
- **Tests:** 16 new (9 for the tree rule, 6 for the component, 1 against PostgreSQL); the factory page test was changed to the new behaviour. Full run with `TEST_DOCKER=1`: 835 tests in 68 files pass. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass.
- No schema change, no new dependency, no new environment variable.

