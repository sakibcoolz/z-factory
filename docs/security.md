# Security Model

Z-Factory controls Docker and therefore crosses a privileged host boundary.

## Mandatory controls
- Docker interaction is server-only.
- Never expose Docker socket or daemon credentials to browser code or Raspberry Pi clients.
- Allow-list container images and runtime capabilities.
- Reject arbitrary command, entrypoint, volume, device, capability, privileged-mode and host-network settings from users.
- Validate IP/subnet/port inputs and detect collisions.
- Use authenticated/authorized factory operations.
- Apply CPU/memory/process limits where supported.
- Keep secrets outside Git; use environment/secret management.
- Treat imported PLC code/configuration as untrusted input.
- Escape/sanitize logs and rendered metadata.

## Production note
Directly mounting `/var/run/docker.sock` gives the application broad host control. Local development may use it with awareness; production should introduce a constrained Docker API boundary/proxy or equivalent isolation.
