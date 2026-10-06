# TASK-308 — Capability-Driven Programmable Device UI & Runtime

Status: **DONE**
Linear: [ZFA-35](https://linear.app/recruit-verse/issue/ZFA-35)

## User stories
- As a user, when I open a programmable PLC or RTU I can write, version, validate and deploy its supported logic from the Z-Factory UI.
- As a user, when I open a VFD or controller that is configuration-driven I see parameters/registers instead of an unsupported PLC-style code editor.
- As an engineer, device programming behavior is determined by catalog capabilities rather than hard-coded device names.
- As a user, unsupported programming features never appear for a device model.

## Scope
- Add model-level programming/configuration capabilities.
- Generalize the existing PLC program/version UI into a reusable programmable-device framework.
- Keep OpenPLC as the first PLC runtime adapter.
- Add RTU-ready program/config capability contracts without claiming vendor firmware emulation.
- Add parameter/configuration UI contract for VFD, PID, temperature and similar controllers.
- Preserve device-specific compiler/runtime/deployer adapters.
- Reuse TASK-307 canonical wiring/tag/I/O mappings.

## Acceptance criteria
- Exact catalog model controls whether Program, Script, Parameters and Communications tabs appear.
- PLC and programmable RTU instances can use the common program/version workflow when their runtime adapter supports it.
- VFD defaults to a parameter/register workflow.
- Program/config versions are immutable and auditable.
- Deploy validates capability, language and runtime support before side effects.
- Existing PLC/OpenPLC workflow remains backward compatible.
- No UI or runtime code assumes that every controller is programmable.
- Documentation in `docs/programmable-devices.md` remains the source of truth.

## Evidence (2026-10-06)
Implemented and verified, and accepted by the owner, on 2026-10-06.

- **The exact catalog model controls which screens appear.** `DeviceModel.capabilities` is declared per model in the catalog (migration `device_capabilities`) and checked against the model's other facts when the catalog is parsed. `deviceSections(model)` (`lib/domain/device-capabilities.ts`) assembles the screens: Program and Versions for a `PROGRAMMABLE` model, Parameters for `PARAMETER_CONFIGURABLE`, Registers for a Modbus model, Communications for ports. Tested: the two generic drives (one category, two models) get different screen sets and neither a program editor; a sensor and a power supply get only what they have; an RTU-category model without the capability is no controller. The PLC shell lists Program and Versions from the capability, not the category.
- **PLC and programmable RTU share the program/version workflow.** A programmable controller is a `PLC` or `RTU` model with `PROGRAMMABLE`; it declares its architecture, gets the controller profile and the PLC screens. The generic `Generic RTU, IEC 61131-3` (new category `RTU`) is created with `createPlc`, gets its 16 I/O points, and `createProgramVersion`, `checkProgram` (a real STruC++ compile) and `listProgramVersions` work for it unchanged (tested against PostgreSQL). In the browser its screens are the PLC screens with Program and Versions.
- **VFD defaults to a parameter/register workflow.** The hardwired drive shows Parameters (maximum frequency, ramp times) and Runtime; the Modbus drive shows Parameters, Registers and Communications. Neither has a Program screen (tested, and seen in the browser).
- **Program/config versions are immutable and auditable.** Each parameter save writes a `ConfigurationVersion` with scope `DEVICE_PARAMETERS`, a number per device and who saved it, and makes the values the device's simulation profile (one profile per device, the simulation plans with it). Tested: two saves give versions 2 and 1 with their own values; program versions are unchanged.
- **Deploy validates capability, language and runtime support before side effects.** `createProgramVersion`, `checkProgram` and `deployProgramVersion` refuse a model without `PROGRAMMABLE` + `IEC_61131_3` on the OpenPLC adapter (`program-capability`) and a program in a language other than Structured Text (`program-language`), and nothing is stored or deployed (tested with a scriptable controller model and a ladder program).
- **Existing PLC/OpenPLC workflow is backward compatible.** Every PLC, runtime, simulation, gateway, demo and end-to-end suite passes unchanged, including the ones against a real OpenPLC runtime; the four vendor PLCs carry `PROGRAMMABLE`, `IEC_61131_3`, `MODBUS_SERVER`.
- **No code assumes every controller is programmable.** The checks that decided "this is a PLC" by category (`createPlc`, `createDeviceInstance`, `placeDevice`, `assertModelArchitecture`, `listCompatiblePeripherals`, the palette order) now ask `isProgrammableController(model)`; `architectureType` stays the discriminator for a controller instance.
- **`docs/programmable-devices.md` is the source of truth** and has an Implementation section with what exists and what does not.
- **In a browser** (headless Chromium, production build, a temporary factory that was removed afterwards): the hardwired drive's Parameters screen; a save with a deceleration time of 0 refused as "Deceleration time: Too small: expected number to be >0." and nothing stored; a valid save confirmed as version 2 and listed; the Modbus drive's Registers screen with Parameters, Registers and Communications in its section list and no Program; the RTU's PLC screens with Program and Versions; the RTU's device URL sending to its PLC screens. The browser check found and fixed one defect: the save action rejected the framework's own `$ACTION_…` form entries.
- **Tests:** 20 new (7 capability rules, 3 parameter fields, 6 against PostgreSQL, 4 for the shell and the form) and the architecture rule tests rewritten for controllers; the suite went from 873 to 894 tests. Full run with `TEST_DOCKER=1`: 894 tests in 75 files pass. `prettier --check`, `eslint`, `tsc --noEmit` and `next build` pass.

## Decisions made in this task
- **Capabilities are catalog data, checked when the catalog is parsed**: `PROGRAMMABLE` iff `controlCapability: PROGRAMMABLE`; OpenPLC models are `PROGRAMMABLE` + `IEC_61131_3`; `PARAMETER_CONFIGURED` models are `PARAMETER_CONFIGURABLE`; Modbus capabilities need a port.
- **Vendor PLC capabilities describe what Z-Factory does with the model** through the OpenPLC adapter (`PROGRAMMABLE`, `IEC_61131_3`, `MODBUS_SERVER`), not the vendor's firmware. Written down in `lib/catalog/capabilities.ts` and `docs/programmable-devices.md`.
- **"Programmable controller" replaces "PLC category"** as the rule for architecture, controller profile and the PLC screens. A PLC must be one; an RTU is one only with the capability.
- **One generic RTU, no vendor RTU.** It demonstrates the shared workflow without a vendor claim.
- **Device screens are route segments like the PLC screens** (`/devices/[deviceId]/…`), not a tabbed single page, so links and tests work the same way.
- **Parameters are the behaviour model's numbers**, described for a form in `lib/domain/device-parameters.ts`; a configurable model without a behaviour model shows the screen and says no set is defined. A declared parameter set of a model for its own sake is not modelled.
- **Saving parameters updates the instance's simulation profile** rather than adding one, so the simulator's "newest profile of the instance wins" rule needs no change; a running simulation keeps its values until restarted.
- **`SCRIPTABLE` and `FIRMWARE_DEPLOYABLE` are declarable, not usable**: no adapter, so no screen offers them; a programmable model without an adapter lists Program and Versions as "no adapter".
- **Controllers have no Communications screen**; their network endpoint stays on the Runtime screen.
- **Development database:** the migration `device_capabilities` is applied and the catalog seeded (capabilities, the `RTU` category and model). The RTU model has no 3D asset and is drawn as a generic shape.

