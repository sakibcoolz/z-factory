# Coding Standards

## TypeScript
- Strict mode required.
- Avoid `any`; use explicit domain types and `unknown` at untrusted boundaries.
- Validate external/input data with Zod.
- Prefer pure domain functions and explicit side-effect services.
- Server-only modules must use the Next.js server-only convention where applicable.
- Client components are opt-in, not the default.

## Naming
- Domain names use industrial terminology consistently: Factory, DeviceModel, FactoryDevice, Rack, Module, Channel, Tag, Connection, Runtime.
- IDs exposed to UI are Z-Factory IDs, never Docker IDs.
- Runtime adapters use `<Runtime>Adapter` naming.

## Error handling
Use typed/domain errors for validation, conflicts, unsupported runtime capability, Docker failure, protocol failure and catalog incompatibility. Do not leak host/internal details to browser responses.

## Logging
Structured logs with factory/device/task correlation IDs. Never log secrets.

## Comments
Explain intent, industrial assumptions and non-obvious constraints. Do not restate code.

## Dependency policy
Add a dependency only when it clearly reduces complexity or risk. Record major architectural dependencies in `docs/architecture.md`.
