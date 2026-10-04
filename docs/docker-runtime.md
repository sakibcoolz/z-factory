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
