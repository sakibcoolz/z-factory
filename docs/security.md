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
- Force-input/fault-injection/debug operations require explicit authorization and audit events.
- Do not expose host paths, Docker socket details, credentials or secrets in PLC exports.

## Single-owner mode (ADR-0007)
The MVP identifies one owner through `LOCAL_OWNER_ID` and does not authenticate the person using the browser: anyone who can reach the server acts as that owner. Keep a deployment reachable only by its owner (localhost, or a trusted network / authenticating reverse proxy). In production the application refuses every factory operation when `LOCAL_OWNER_ID` is not set.

## OpenPLC runtime access (ADR-0008)
- Each PLC container's REST API and Modbus server are published on loopback host ports only (`RUNTIME_BIND_ADDRESSES`, default `127.0.0.1`).
- The runtime uses a self-signed certificate generated at start; the client does not verify it and therefore refuses any non-loopback address.
- API credentials are derived per device from `RUNTIME_SECRET` and never stored. Production must set the secret; changing it requires recreating the containers.
- Program source is untrusted input: it is size-limited, compiled in a separate process with a time and memory cap, and built inside the runtime container, never on the host.
- Raw Modbus writes go only to coils and holding registers; read-only areas are refused before anything is sent. Restricting writes to command/setpoint tags is enforced with the tag mapping of TASK-203.

## Industrial-control warning
Z-Factory is a simulation/development platform. It must not claim safety-rated behavior or be used as the sole safety-control layer for physical machinery.

## Production note
Directly mounting `/var/run/docker.sock` gives broad host control. Local development may use it knowingly; production should introduce a constrained Docker API proxy/boundary or equivalent isolation.
