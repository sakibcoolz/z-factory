# TASK-308 — Capability-Driven Programmable Device UI & Runtime

Status: **PLANNED**
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
