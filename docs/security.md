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
- Catalog 3D assets (TASK-402, ADR-0012): a GLB is untrusted input. It is size-limited and checked before it is stored, must be self-contained, and is only ever written by server-side authoring, never uploaded through a request. Storage keys are made by the server and confined to the storage directory. The 3D view loads models only from Z-Factory's own asset route and fetches no decoder, font or texture from another host.
- Asset generation (TASK-403): the Meshy key is read from `MESHY_API_KEY` by the authoring script only, is sent to the provider's API host only (in the Authorization header), and appears in no error, log line, stored record or response. No page, route, action or component imports the provider or the authoring service (checked by a test), so nothing a browser does can generate an asset or spend credits. A generated file is fetched only over HTTPS from the provider's own hosts, without the key, is size-limited, and is checked and normalized like any other untrusted GLB before it is stored. The signed download address is used once and not stored. Prompts never name a manufacturer or a product.
- The live stream (TASK-401) is one-way and has the same authorization as the factory's screens; a factory of another owner is not found. It carries event payloads and tag values, never a container id, a management port or credentials. Every write of a tag is recorded as an event, and so is every refused write.
- Runtime screens (TASK-305) identify a PLC runtime by its Z-Factory id and service name. Their read models carry no container id and no management port; a failed operation shows its domain message, while build logs and Docker causes stay in the server log.

## Single-owner mode (ADR-0007)
The MVP identifies one owner through `LOCAL_OWNER_ID` and does not authenticate the person using the browser: anyone who can reach the server acts as that owner. Keep a deployment reachable only by its owner (localhost, or a trusted network / authenticating reverse proxy). In production the application refuses every factory operation when `LOCAL_OWNER_ID` is not set.

## OpenPLC runtime access (ADR-0009)
- Each PLC container's REST API and Modbus server are published on loopback host ports only (`RUNTIME_BIND_ADDRESSES`, default `127.0.0.1`).
- The runtime uses a self-signed certificate generated at start; the client does not verify it and therefore refuses any non-loopback address.
- API credentials are derived per device from `RUNTIME_SECRET` and never stored. Production must set the secret; changing it requires recreating the containers.
- Program source is untrusted input: it is size-limited, compiled in a separate process with a time and memory cap, and built inside the runtime container, never on the host.
- Writes through Z-Factory go by tag: only `COMMAND` and `SETPOINT` tags are writable, values are type- and range-checked, and each write is recorded as a `DeviceCommand`. Raw Modbus access refuses read-only areas before anything is sent.
- **Limit:** the runtime's Modbus server itself has no per-register permissions. A client that reaches the published Modbus port directly can write any coil or holding register, including ones Z-Factory treats as read-only. Keep that port on loopback (the default). An external gateway does not use it: it connects to a gateway endpoint, which enforces the tag permissions (below).

## Gateway endpoints (TASK-501, ADR-0013)
- An external device reaches a PLC only through a gateway endpoint: a Modbus TCP listener of the server process on an address from `RUNTIME_BIND_ADDRESSES` and a port from `RUNTIME_PORT_RANGE`. It is never given the PLC's own Modbus port, the runtime's management port, the web interface or anything of Docker.
- The endpoint hands out the tags mapped to that gateway and nothing else. A read that touches an unmapped address is refused, so a client cannot sweep a PLC. A write is accepted only for a tag mapped as writable, and only command and setpoint tags can be mapped that way; the write then goes through the tag service like any other and is recorded as a command with source `GATEWAY`.
- Refused writes are recorded (`COMMAND_REJECTED`, rule `gateway-unmapped`, `gateway-read-only` or `gateway-partial-value`). A device that came or went is recorded too.
- Requests are untrusted input: frame length, function, quantity and unit id are checked before anything is done, a connection that does not speak Modbus TCP is closed, and an endpoint takes at most 4 connections.
- **Limit:** Modbus TCP has no authentication. Anyone who can reach an endpoint's port can do what its mappings allow. Bind endpoints to a specific address, allow the port in the host firewall only from the device's address, and map only what the device needs.
- The register map download carries the endpoint, the unit id and the mapped tags; no container id, management port or credential.

## Industrial-control warning
Z-Factory is a simulation/development platform. It must not claim safety-rated behavior or be used as the sole safety-control layer for physical machinery.

## Production note
Directly mounting `/var/run/docker.sock` gives broad host control. Local development may use it knowingly; production should introduce a constrained Docker API proxy/boundary or equivalent isolation.


## Go process simulation service (Phase 06+)
ADR-0008 permits a separate Go simulation service only after the MVP foundation. It is a privileged internal runtime component, not a browser-facing arbitrary execution API. Validate all module/model configuration, restrict network exposure to approved factory/runtime paths, apply resource limits, and keep simulator control behind the existing authorization/audit boundaries.

Process models are not safety-rated controllers. PLC/safety interlocks simulated by Z-Factory must never be represented as certified protection.
