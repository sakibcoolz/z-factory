# Coding Standards

## TypeScript
- Strict mode required.
- Avoid `any`; use explicit domain types and `unknown` at untrusted boundaries.
- Validate external/input data with Zod.
- Prefer pure domain functions and explicit side-effect services.
- Server-only modules must use the Next.js server-only convention where applicable.
- Client components are opt-in, not the default.

## Naming
Use industrial terminology consistently:
- `Factory`
- `DeviceCategory`, `DeviceModel`, `DeviceInstance`
- `PlcIoPoint`, `Tag`, `DeviceConnection`
- `GatewayPlcConnection`, `GatewayTagMapping`
- `ProgramVersion`, `ConfigurationVersion`
- `RuntimeEvent`, `AlarmEvent`, `TelemetrySample`

PLC instance names should identify manufacturer/family/model; process role is separate metadata. Factory peripheral names should be unique and human-readable, e.g. `VFD-01`, `MOTOR-01`, `PUMP-01`, `PT-101`.

IDs exposed to UI are Z-Factory IDs, never raw Docker IDs.

Runtime adapters use `<Runtime>Adapter` naming. Simulator implementations should expose explicit state/config types rather than unstructured JSON internally.

## Domain boundaries
- Catalog model != factory instance.
- Hardware profile != runtime.
- Command/setpoint != feedback/status/alarm.
- Live runtime state != persisted history.
- PLC control logic != gateway transport.

Do not collapse these concepts for implementation convenience.

## Protocol code
Register codecs must make data type, word count, byte order, word order, scaling and address-area conventions explicit. Avoid magic register numbers scattered through UI/services.

## Simulation code
Device simulators should be deterministic/testable where practical. Time/tick handling should be injectable. State transitions and approximations must be documented.

## Error handling
Use typed/domain errors for validation, conflicts, occupied endpoints, unsupported runtime capability, Docker failure, protocol failure, catalog incompatibility, compile/deploy failure and simulation fault. Do not leak host/internal details to browser responses.

## Logging
Structured logs with factory/device/task/correlation IDs. Never log secrets.

## Comments
Explain intent, industrial assumptions and non-obvious constraints. Do not restate code.

## Dependency policy
Add a dependency only when it clearly reduces complexity or risk. Record major architectural dependencies in `docs/architecture.md`.
