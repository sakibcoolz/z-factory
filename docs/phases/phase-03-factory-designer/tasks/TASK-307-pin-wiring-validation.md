# TASK-307 — Pin-to-Pin Wiring Editor & Validation

Status: **PLANNED**
Linear: [ZFA-34](https://linear.app/recruit-verse/issue/ZFA-34)

## Objective
Replace the PLC-centric compact mapping workflow with one authoritative pin-to-pin wiring workflow in the Phase 03 Factory Designer.

## User stories
- As a factory designer, I can connect an exact device pin/terminal to an exact compatible PLC or device pin.
- As a user, I see why a proposed connection is invalid before it is saved.
- As a user, I can edit, disconnect and reconnect a wire without creating duplicate mappings.
- As an engineer, I can trust that saved wiring is reused by OpenPLC mapping, simulation, export, telemetry and 3D.

## Rules
Each connectable endpoint carries engineering metadata: endpoint role, direction, signal class, electrical standard/range, protocol/port type, occupancy and sharing policy.

Default behavior:
- DI/DO/AI/AO and other signal endpoints allow one active connection.
- A second connection to an occupied signal endpoint is rejected.
- Power distribution, 0V/COM, PE/earth and supported bus endpoints may allow multiple connections only when catalog metadata explicitly marks them shareable.
- Shared endpoints must still honor electrical compatibility and capacity limits.
- Validation rejects incompatible direction, signal class, voltage/current standard, protocol, duplicate wiring and occupied endpoints.
- Error messages name both endpoints and the failed rule.

## 2D UX
2D topology stays intentionally compact:
- one logical edge between connected devices;
- selecting an edge reveals its physical pin/terminal mappings;
- pin-level edit mode exposes exact source and destination endpoints;
- incompatible destinations are blocked with an alert/error;
- invalid wiring is never persisted.

The system must not auto-wire every terminal merely because two device nodes are connected.

## Canonical mapping
Persisted physical wiring is the single source of truth.

Example:
`PT-101 / OUT+ -> PLC-01 / Slot-2 / AI-Module-01 / AI2`

Existing TASK-302 Connections/I/O Mapping views become read-only projections or are retired after migration. They must not remain a second writable mapping source.

## Acceptance criteria
- Exact endpoint-to-endpoint wiring persists and reloads.
- Wrong pin/type/direction/range connections are rejected before save.
- Occupied signal endpoints reject a second wire.
- Explicitly shareable 24V, 0V/COM, PE/earth and supported bus endpoints can accept multiple wires within defined limits.
- Edit/reconnect preserves the old connection until the replacement validates.
- 2D shows one logical edge per device relationship and exposes physical mappings in the inspector/edit mode.
- OpenPLC mapping, simulation, export, telemetry and Phase 04 3D consume the same canonical wiring.
