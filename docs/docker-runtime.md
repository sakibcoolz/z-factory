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
`RUNTIME_IMAGES` lists each runnable image with a key, `repository:tag`, optional pinned digest, fixed command, publishable container ports and allowed environment variable names. A request names a key, never a reference. The list is empty until TASK-202 (OpenPLC) and TASK-204 (device simulator) add their images, so the application cannot start any container yet. Program and configuration artifacts will be copied into containers through the Docker API, not bind-mounted.

### Networks
`ensureFactoryNetwork` creates a bridge network named `zfactory_<factoryId>` on the factory subnet, labelled `zfactory.managed=true` and `zfactory.factory-id`. It is idempotent, refuses a subnet that overlaps any existing Docker network on the host, and refuses to reuse a name held by a different network. `removeFactoryNetwork` only removes managed networks with no containers attached.

### Ports
A published port must use an allowed bind address (`RUNTIME_BIND_ADDRESSES`, default `127.0.0.1`), fall inside `RUNTIME_PORT_RANGE` (default `15000-15999`), be a port the image declares publishable, and not collide with a port already published by any running container or reserved by a not-yet-started Z-Factory container. Persisted `RuntimePort` rows and the per-factory mapping arrive with TASK-203.

### Managed-only rule
Start, stop, restart, remove and inspect first check the `zfactory.managed` label and refuse anything else, so other containers and networks on the host are never touched.

### Not yet wired
No screen starts a factory: the Docker layer is exercised by its tests only. The OpenPLC adapter (TASK-202) is the first caller. The factory screens show whether the engine is reachable.
