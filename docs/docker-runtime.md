# Docker Runtime Design

## Integration
Next.js server uses the Docker Engine API through a maintained Node.js client such as dockerode. Browser code never connects to Docker.

## PLC creation abstraction
The user creates a PLC. Backend converts that form into runtime resources.

Prefer:
```text
Reusable OpenPLC image
+ PLC-specific generated config
+ program artifact
+ I/O/tag/Modbus map
+ container/network settings
= virtual PLC container
```

Do not generate a unique Dockerfile/image for every PLC or device unless a custom image is genuinely required.

## Factory runtime
Each factory receives:
- one isolated Docker network by default;
- deterministic internal service/DNS names;
- OpenPLC container(s);
- a shared device-simulator runtime for ordinary peripherals;
- optional gateway simulator;
- published host ports only when external access is enabled.

Example:
```text
zfactory_factory_001
  s7-1200-1214c-01
  s7-1500-1511pn-01
  device-simulator
  gateway-01 (optional)
```

## Device-simulator strategy
Do not create one container per sensor, valve, motor, pump or VFD by default. A shared simulator process/container hosts multiple factory-specific device state machines. Dedicated containers are allowed when protocol isolation/fidelity requires them.

As implemented (TASK-204, ADR-0010) the shared simulator is part of the server process, not a container on the factory network: the `device-simulator` entry in the example above is not created. It reaches each PLC through the PLC's published Modbus port.

## Process simulation service (TASK-602)
The ADR-0008 service is one container for the whole installation, started from `compose.yaml` (`--profile sim`), not a factory runtime container: it is not on any factory network and is not created through the Docker Engine API by the application. It runs a distroless static binary as a non-root user with a read-only filesystem, all capabilities dropped, `no-new-privileges`, 1 CPU, 256 MB and 128 processes, and listens on `127.0.0.1:7700`. The server reaches it over HTTP with a bearer token (`PROCESS_SIM_URL`, `PROCESS_SIM_TOKEN`). See `docs/process-simulation.md`.

## PLC-to-PLC traffic (TASK-703)
PLCs of one factory talk to each other on the factory network. Every PLC container joins the network with its service name as DNS alias (`serviceNameFor(device name)`, e.g. `PLC-MACHINE` → `plc-machine`), and the client PLC's runtime reaches the server's Modbus TCP server at `<service name>:502`. No IP address is configured and no host port is used for this traffic; the published Modbus port of a PLC stays for gateways, live values and Z-Factory's own health probe. A PLC of another factory is on another network and cannot be reached (links across factories are refused anyway).

## Port example
`host:15021 -> s7-1200-1214c-01:502`

External edge hardware connects to the Docker-host LAN address plus the validated published port.

## Generated artifacts
A PLC runtime directory/config package may contain:
```text
plc-config.json
io-map.json
tag-map.json
modbus-map.json
program.st
runtime-config.json
compose-runtime.yaml   # optional export/debug artifact
```

## Edit/redeploy
DB/config change -> regenerate affected artifacts -> deploy/reload program -> restart/recreate container only when required.

## Safety
- allow-list runtime images;
- never accept arbitrary volume mounts or privileged flags;
- restrict host networking;
- validate ports/networks;
- apply CPU/memory limits;
- record image digest/runtime configuration;
- never execute arbitrary host shell commands from browser input.

## Implementation (TASK-201)
Everything lives in `lib/docker/` and is server-only. The UI never receives a Docker id.

| Module | Responsibility |
|---|---|
| `client.ts` | dockerode client from `DOCKER_HOST` (unix socket or TCP proxy) |
| `policy.ts`, `runtime-images.ts` | what may run: image allow-list, port range, bind addresses, CPU/memory/process limits |
| `spec.ts` | strict request schemas and the hardened Docker create options |
| `networks.ts` | create/confirm/remove the factory network |
| `images.ts` | pull an allow-listed image when missing; verify its pinned digest |
| `ports.ts` | host-port validation against policy and ports already claimed on the host |
| `containers.ts` | create, start, stop, restart, remove, inspect |
| `status.ts` | engine reachability for the host status in the UI |
| `errors.ts` | Docker failures → typed domain errors without daemon text |

### Request contract
A container request has exactly these fields: `factoryId`, `deviceId`, `networkName`, `serviceName`, `image` (an allow-list key), `env`, `ports`, `limits`. The schema is strict: any other key (privileged, binds, volumes, mounts, command, entrypoint, capabilities, devices, network/pid mode, user…) is rejected before Docker is called.

### Fixed container settings
Not privileged; all capabilities dropped; `no-new-privileges`; no binds, mounts or devices; network mode is the factory network only; restart policy `no`; an init process; log rotation (10 MB × 3); CPU, memory (no extra swap) and PID limits. Defaults: 1 CPU, 256 MB, 256 processes; maximum 2 CPUs and 1024 MB.

### Image allow-list
`RUNTIME_IMAGES` lists each runnable image with a key, `repository:tag`, pinned digest, optional fixed command, publishable container ports, allowed environment variable names and default limits. A request names a key, never a reference. It currently holds one image: `openplc` → `ghcr.io/autonomy-logic/openplc-runtime:v4.2.4` pinned by digest, publishable ports 8443 (REST API) and 502 (Modbus TCP), 1 GB memory (ADR-0009). The device simulator needs no image: it runs inside the server process (ADR-0010). Programs and configuration reach a container through its REST API, never through mounts.

### Networks
`ensureFactoryNetwork` creates a bridge network named `zfactory_<factoryId>` on the factory subnet, labelled `zfactory.managed=true` and `zfactory.factory-id`. It is idempotent, refuses a subnet that overlaps any existing Docker network on the host, and refuses to reuse a name held by a different network. `removeFactoryNetwork` only removes managed networks with no containers attached.

Creating a factory, and changing its subnet, check the subnet against the same host networks before anything is stored (TASK-207): `listHostNetworks` lists every network on the host, whoever created it, and the factory's own network is left out. A clash is refused on the subnet field ("This subnet overlaps a network that already exists on the Docker host.", rule `docker-subnet-overlap`). If Docker cannot be reached, nothing is saved and the user is told that the subnet could not be checked (rule `subnet-check-unavailable`). The subnet offered on the create form, and the one the pump station demo takes, are free both among the factories and on the host. The check at network creation stays, for whatever appears on the host in between.

### Ports
A published port must use an allowed bind address (`RUNTIME_BIND_ADDRESSES`, default `127.0.0.1`), fall inside `RUNTIME_PORT_RANGE` (default `15000-15999`), be a port the image declares publishable, and not collide with a port already published by any running container or reserved by a not-yet-started Z-Factory container. `RUNTIME_BIND_ADDRESSES` must include `127.0.0.1`: runtime management APIs are always published on loopback. A PLC's Modbus endpoint is persisted as a `RuntimePort` row and is stable configuration: ports reserved in the database count as taken when allocating, and the endpoint survives removing the container. Gateway endpoints (TASK-501) are listeners of the server process, not container ports, but they are checked against the same bind addresses, range and reservations, and a gateway connection's port counts as taken.

### Managed-only rule
Start, stop, restart, remove and inspect first check the `zfactory.managed` label and refuse anything else, so other containers and networks on the host are never touched.

### Deleting a factory (TASK-206)
Deleting a factory removes its Docker resources first (`removeFactoryResources`, `lib/docker/factory-resources.ts`): every container and network labelled `zfactory.managed=true` and `zfactory.factory-id=<factoryId>`, containers before the network. It refuses while any of them is running, restarting or paused. The database record is deleted only after everything is gone. If Docker cannot be reached or a resource cannot be removed, the factory is kept and the user is told why, so a retry finishes the job. Unmanaged containers, and resources of other factories, are never touched.

### Callers
The OpenPLC adapter and the PLC runtime service (TASK-202) are the callers of this layer. Since TASK-305 a stored PLC's Runtime screen starts, stops, restarts and removes its container through that service; the factory screens show whether the engine is reachable. No screen receives a container id, a network id or the management port.
