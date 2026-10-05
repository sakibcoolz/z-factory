# External Gateway & Modbus TCP

## MVP protocol
Modbus TCP is the first external industrial protocol.

## Control authority
External gateway commands always target PLC command/setpoint tags/registers.

```text
Cloud / Remote UI
      -> Industrial Edge Gateway
      -> Modbus TCP write
      -> PLC command/setpoint tag
      -> OpenPLC logic
      -> VFD / valve / output command
      -> device simulation
```

The gateway must not directly mutate VFD, motor, pump or valve simulator state.

## Feedback path

```text
device simulation
   -> PLC feedback/status/alarm tags
   -> Modbus TCP read
   -> Industrial Edge Gateway
   -> Cloud / Remote UI
```

## Register semantics
Typical use:
- coils: boolean commands/status
- holding registers: writable numeric setpoints/config values
- input registers: read-only process/feedback values

Do not hard-code 3xxxx/4xxxx display notation into protocol internals; store normalized Modbus area + zero/one-based address convention explicitly.

## Address mapping of the OpenPLC runtime (ADR-0009)
The runtime's Modbus server maps located variables to fixed areas; Z-Factory does not choose these addresses:

| Located variable | Modbus area | Address |
|---|---|---|
| `%QX<byte>.<bit>` | coils (read/write) | `byte * 8 + bit` |
| `%IX<byte>.<bit>` | discrete inputs (read-only) | `byte * 8 + bit` |
| `%IW<n>` | input registers (read-only) | `n` |
| `%QW<n>` | holding registers (read/write) | `n` |
| `%MW`, `%MD`, `%ML` | holding registers, after the `%QW` segment | segment offset + index |

Inside the factory network the server listens on port 502 of the PLC's service name; on the host it is published on a loopback port from `RUNTIME_PORT_RANGE`.

## Data types
Each mapping records:
- data type
- register word count
- byte order
- word order
- scale/offset
- engineering unit
- read/write permission
- semantic role

A FLOAT32 generally occupies two 16-bit registers.

## Example logical map
```text
Pump01_StartCommand       BOOL     COMMAND    Coil
VFD01_FrequencySetpoint   FLOAT32  SETPOINT   Holding registers
VFD01_ActualFrequency     FLOAT32  FEEDBACK   Input/holding mapping by runtime contract
Motor01_ActualRPM         UINT16   FEEDBACK
Pump01_Pressure           FLOAT32  PROCESS_VALUE
Pump01_Fault              BOOL     ALARM/STATUS
```

## Gateway configuration
Gateway-to-PLC connection stores host/DNS, port, unit ID, poll interval and tag mappings. External physical gateways connect to validated Docker-host published endpoints.

## Safety/interlocks
A successful Modbus write is not equivalent to successful device action. PLC logic may reject/ignore a command due to E-stop, permissive, fault, low level, overload, interlock or mode.

UI/API should distinguish:
- command requested
- write accepted
- PLC command state
- device actual state
- fault/interlock state

## Implementation (TASK-203)
Code: `lib/protocols/modbus/` (client, codecs, located-address mapping), `lib/services/tag-service.ts`, `lib/services/plc-runtime-service.ts` (endpoint).

### Tag registry
A tag names one located variable of the PLC program. Creating a tag takes `name`, `dataType`, `role`, `logicalAddress` and optional `scale`, `offset`, `unit`, `sourceDeviceInstanceId`. Everything else is derived and cannot be supplied:

| Derived | From |
|---|---|
| Modbus area, zero-based address, word count | the located address, by the runtime's fixed layout |
| direction | `%I` → INPUT, `%Q` → OUTPUT, `%M` → INTERNAL |
| access mode | `READ_WRITE` for `COMMAND` / `SETPOINT`, otherwise `READ_ONLY` |
| byte order, word order | `BIG_ENDIAN`, `HIGH_WORD_FIRST` (fixed by the runtime) |

Supported located addresses and data types:

| Located | Data types | Modbus |
|---|---|---|
| `%QX<byte>.<bit>` | BOOL | coil `byte*8+bit` |
| `%MX<byte>.<bit>` | BOOL | coil `8192 + byte*8+bit` |
| `%IX<byte>.<bit>` | BOOL | discrete input `byte*8+bit` |
| `%IW<n>` | INT16, UINT16 | input register `n` |
| `%QW<n>` | INT16, UINT16 | holding register `n` |
| `%MW<n>` | INT16, UINT16 | holding register `1024 + n` |
| `%MD<n>` | INT32, UINT32, FLOAT32 | holding registers `2048 + 2n` and `+1` |

32-bit values exist only in `%MD`; `%QD`, `%ID`, byte and 64-bit addresses are rejected. Indexes are limited to 1024 per segment (1024 bytes for bit areas).

### Validation
- Tag names are IEC identifiers, unique per PLC.
- The data type must fit the address size.
- A `COMMAND` or `SETPOINT` tag must sit on a writable address (`%Q` or `%M`).
- Two tags may not overlap in the same area, counting every word of a multi-word value.
- The source device must be an instance of the same factory.
- The database repeats the role/access and area/access rules as CHECK constraints.

Every create or delete bumps `PlcInstanceProfile.modbusMappingVersion`. Each program deployment stores the tag map in its `ConfigurationVersion` snapshot.

### Modbus map contract
`getModbusMap` returns what the PLC inspector shows and the engineering export contains: the mapping version, the conventions (`zero-based`, `BIG_ENDIAN`, `HIGH_WORD_FIRST`), the host endpoint, and one row per tag with name, role, data type, direction, located address, area, zero-based address, word count, access mode, orders, scale, offset, unit, source device and the device signal it is wired to (`docs/device-simulation.md`). `displayAddress` (`40001`, `42049`, …) is derived for people and never stored.

### Typed values
Engineering value = raw × scale + offset. `readTag` / `readTags` decode register words into numbers or booleans and report a quality: `GOOD`, or `DISCONNECTED` / `BAD` with no value when the PLC cannot be read. `writeTag` encodes and range-checks the value (single coil, single register, or function 16 for two-word values).

### Write permissions and command records
`writeTag` refuses any tag that is not `COMMAND` or `SETPOINT` before anything is sent. An allowed write is stored as a `DeviceCommand` (`WRITE_TAG`, requested value, source) with status `ACCEPTED` once the PLC took the value, or `FAILED`. `appliedAt` stays empty: whether the device acted is decided by PLC logic and read back from feedback tags.

Since TASK-401 every write is also a recorded event: `COMMAND_ACCEPTED` or `COMMAND_FAILED`, and `COMMAND_REJECTED` for a write to a tag that is not writable (which reaches no PLC). A write with source `GATEWAY` records `GATEWAY_COMMAND_RECEIVED` first; the gateway itself is Phase 05. The Live Tags screen writes with source `UI`.

### External endpoint
Each PLC's Modbus server is published on one host endpoint, stored as a `RuntimePort`. By default a free loopback port from `RUNTIME_PORT_RANGE` is allocated on first start. `configureModbusEndpoint` sets an explicit bind address and port, validated against the allowed addresses, the port range and every port already published or reserved; it applies on the next start and is refused while a container exists. Inside the factory network other containers use `<service-name>:502`; containers on other networks cannot resolve or reach it.

### Limits
- The runtime's own Modbus server does not enforce per-register permissions; see `docs/security.md`. An external gateway therefore connects to a gateway endpoint (below), not to that server.
- The tag registry is not yet checked against the located variables a program declares.
- PLC-to-PLC mappings belong to Phase 07 and reuse the codecs and rules above.

## Implementation (TASK-501, ADR-0013): gateway endpoints
Code: `lib/domain/gateway.ts` (what a gateway may read and write, pure), `lib/protocols/modbus/server.ts` (Modbus TCP server), `lib/runtimes/gateway-endpoint/` (the endpoints of this server process), `lib/services/gateway-service.ts`, screen `/factories/[factoryId]/gateways`.

```text
edge device --Modbus TCP--> gateway endpoint (this host: address, port, unit id)
                               | read of mapped addresses  -> PLC Modbus server (loopback)
                               | write of a writable mapping -> writeTag(source GATEWAY)
                               |      -> DeviceCommand + events -> PLC command/setpoint tag
                               | anything else -> Modbus exception, PLC not asked
```

### What a gateway is
A gateway is a device of the factory (category `GATEWAY` or `EDGE_GATEWAY`) that stands for the external device. It is added on the Gateways screen or placed in the designer. Connecting it to a PLC stores a `GatewayPlcConnection`: the address and port of this host the device connects to, the unit id it must use, and how often it is expected to read. A gateway has one connection per PLC; each connection has its own endpoint.

### What it is given
A mapping (`GatewayTagMapping`) gives the gateway one tag: to read, or to read and write. Writing can be granted only for a `COMMAND` or `SETPOINT` tag. A mapped tag appears at its own Modbus area and address, so the register map is the PLC's map with everything unmapped left out. "Map all tags" maps commands and setpoints as writable and everything else for reading.

The register map of a connection is downloaded from the screen (`…/gateways/<connection id>/map.json`, schema `z-factory.gateway-map` version 1): endpoint, unit id, poll interval, conventions (zero-based addresses, big-endian, high word first) and per tag its name for the gateway, area, address, word count, data type, scale, offset, unit and access. Values on the wire are the PLC's raw values: engineering value = raw × scale + offset.

### What the endpoint answers
| Request | Answer |
|---|---|
| read (functions 1, 2, 3, 4) of addresses that are all mapped | the PLC's values |
| read that touches an unmapped address, also between two mapped tags | exception 02 |
| write (5, 6, 15, 16) of whole values mapped as writable | written through the tag service; recorded as a command |
| write to a tag mapped for reading, to an unmapped address, or to half of a two-word value | exception 02; recorded as `COMMAND_REJECTED` |
| write of a value the tag cannot hold | exception 03 |
| the PLC is not started or does not answer | exception 0B |
| another unit id | exception 0A |
| any other function | exception 01 |
| bytes that are not Modbus TCP | the connection is closed |

A write that is accepted means the PLC took the value. What the device then does is PLC logic's decision and is read back from feedback tags, as for a write from the UI.

### Network prerequisites
1. **An address the device can reach.** An endpoint listens on one of the addresses in `RUNTIME_BIND_ADDRESSES`. The default is `127.0.0.1` only, which no other machine can reach. Add the LAN address of the Docker host, e.g. `RUNTIME_BIND_ADDRESSES=127.0.0.1,192.168.0.103`, and restart the server. `127.0.0.1` must stay in the list. Do not use `0.0.0.0`: an endpoint is bound to one address on purpose.
2. **A port.** Any free port of `RUNTIME_PORT_RANGE` (default 15000–15999); the screen suggests the highest free one, because PLC runtimes are given ports from the bottom of the range. A gateway connection's port is reserved: no PLC runtime is given it. Ports below 1024 are not offered: the server does not run as root. A device that can only use port 502 needs a port forward on the host or router from 502 to the endpoint's port.
3. **The host firewall.** Allow TCP to that port from the device's address only, for example with firewalld: `firewall-cmd --add-rich-rule='rule family=ipv4 source address=192.168.0.50/32 port port=15000 protocol=tcp accept'` (add `--permanent` to keep it). With ufw: `ufw allow from 192.168.0.50 to any port 15000 proto tcp`. Do not open the range to the whole network.
4. **The same network.** The device and the host must be able to route to each other; a guest Wi-Fi or client-isolation setting on an access point prevents that.
5. **Nothing else is needed, and nothing else should be opened.** The device needs no access to the PLC's own Modbus port, to the runtime's management port, to the web interface or to Docker. Keep `DOCKER_HOST` and the PLC ports on loopback.

### Checking from the edge device
With the register map at hand, from a Raspberry Pi with Python and `pymodbus`:

```python
from pymodbus.client import ModbusTcpClient

client = ModbusTcpClient("192.168.0.103", port=15000)   # endpoint host and port from the map
client.connect()
print(client.read_coils(80, count=1, slave=1).bits[0])            # a mapped command tag
print(client.read_holding_registers(1124, count=1, slave=1).registers[0] * 0.1)  # raw x scale
client.write_register(10, 455, slave=1)                            # a setpoint: 45.5 at scale 0.1
print(client.write_coil(8992, True, slave=1))                      # feedback: refused, exception 2
client.close()
```

The first lines succeed only while the PLC runtime is started; otherwise they answer exception 0B. The last line is always refused.

`scripts/edge-client.mjs` does the same from Node.js with the register map file and no other dependency: `node scripts/edge-client.mjs map.json read`, `write <name> <value>`, `watch [seconds]` (`docs/demo-runbook.md`).

### Limits
- Endpoints live in the server process and are opened from the stored connections when the factory's Gateways screen is read, a gateway is configured or the factory is started. After a server restart nothing listens until then.
- The gateway device shows the state of its endpoints in the designer, the topology and the 3D view: running while they are open, faulted when one could not be opened.
- Modbus TCP does not authenticate a client. Who may connect is decided by the bind address and the firewall.
- Up to 4 connections per endpoint; a connection that is silent for 2 minutes is closed. Every read is forwarded to the PLC as one request.
- A device that opens a connection per request is recorded as one visit: `GATEWAY_CLIENT_CONNECTED` when it first appears and `GATEWAY_CLIENT_DISCONNECTED` after 15 seconds without a connection.
- A connection's address, port and unit id are changed by removing it and connecting again; its mappings go with it.
- Verified with a Modbus client on the same host over the LAN address, and in a closed loop against a real OpenPLC runtime. Not yet verified with a physical edge device.
