# Docker Runtime Design

## Integration
The Next.js server uses the Docker Engine API through a Node.js library such as dockerode or an equivalent maintained client.

Browser code never connects to Docker.

## Factory runtime
Each factory receives:
- isolated Docker network;
- deterministic internal hostnames;
- one or more runtime containers;
- published host ports only when external access is enabled.

## Port example
`host:15021 -> plc-01:502`
`host:15022 -> vfd-01:502`

The Raspberry Pi connects to the Docker host LAN IP plus published port.

## Dockerfile vs container configuration
Do not generate a unique Dockerfile for every device unless a custom image is truly required. Prefer reusable versioned images plus generated environment/config volumes. A generated Compose file may be offered for export/reproducibility.

## Safety
- allow-list images/runtimes;
- never accept arbitrary volume mounts;
- never accept arbitrary privileged flags;
- restrict host networking;
- validate published ports;
- apply CPU/memory limits;
- record image digest and runtime configuration.
