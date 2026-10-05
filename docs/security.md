# Security Model

Z-Factory controls Docker and industrial command paths, so it crosses privileged host and control boundaries.

## Mandatory controls
- Docker interaction is server-only.
- Never expose Docker socket/daemon credentials to browser or external gateway clients.
- Allow-list container images and runtime capabilities.
- Reject arbitrary command, entrypoint, volume, device, capability, privileged-mode and host-network settings.
- Validate IP/subnet/port inputs and detect collisions.
- Use authenticated/authorized factory operations.
- Apply CPU/memory/process limits where supported.
- Keep secrets outside Git.
- Treat imported PLC code/configuration and exported/imported configuration packages as untrusted input.
- Escape/sanitize logs and rendered metadata.
- Validate PLC tag/register write permissions and data types.
- External gateway writes are restricted to explicitly writable PLC command/setpoint mappings.
- Gateway/API paths must never directly mutate downstream motor/pump/VFD/valve simulator state.
- Enforced by wiring (TASK-204): a device signal can only be bound to a tag that gateways and the UI cannot write, so device inputs come from the PLC program alone. Fault injection, device reset and forced sensor values are separate, authenticated operator actions on the simulated equipment and are always recorded as events.
- Force-input/fault-injection/debug operations require explicit authorization and audit events.
- Do not expose host paths, Docker socket details, credentials or secrets in PLC exports.

## Single-owner mode (ADR-0007)
The MVP identifies one owner through `LOCAL_OWNER_ID` and does not authenticate the person using the browser: anyone who can reach the server acts as that owner. Keep a deployment reachable only by its owner (localhost, or a trusted network / authenticating reverse proxy). In production the application refuses every factory operation when `LOCAL_OWNER_ID` is not set.

## OpenPLC runtime access (ADR-0009)
- Each PLC container's REST API and Modbus server are published on loopback host ports only (`RUNTIME_BIND_ADDRESSES`, default `127.0.0.1`).
- The runtime uses a self-signed certificate generated at start; the client does not verify it and therefore refuses any non-loopback address.
- API credentials are derived per device from `RUNTIME_SECRET` and never stored. Production must set the secret; changing it requires recreating the containers.
- Program source is untrusted input: it is size-limited, compiled in a separate process with a time and memory cap, and built inside the runtime container, never on the host.
- Writes through Z-Factory go by tag: only `COMMAND` and `SETPOINT` tags are writable, values are type- and range-checked, and each write is recorded as a `DeviceCommand`. Raw Modbus access refuses read-only areas before anything is sent.
- **Limit:** the runtime's Modbus server itself has no per-register permissions. A client that reaches the published Modbus port directly can write any coil or holding register, including ones Z-Factory treats as read-only. Publish that port only where the client is trusted (default: loopback), and let PLC logic overwrite feedback values every scan. Enforcing tag permissions for external gateways needs a filtering proxy, which belongs to Phase 05.

## Industrial-control warning
Z-Factory is a simulation/development platform. It must not claim safety-rated behavior or be used as the sole safety-control layer for physical machinery.

## Production note
Directly mounting `/var/run/docker.sock` gives broad host control. Local development may use it knowingly; production should introduce a constrained Docker API proxy/boundary or equivalent isolation.


## Go process simulation service (Phase 06+)
ADR-0008 permits a separate Go simulation service only after the MVP foundation. It is a privileged internal runtime component, not a browser-facing arbitrary execution API. Validate all module/model configuration, restrict network exposure to approved factory/runtime paths, apply resource limits, and keep simulator control behind the existing authorization/audit boundaries.

Process models are not safety-rated controllers. PLC/safety interlocks simulated by Z-Factory must never be represented as certified protection.
