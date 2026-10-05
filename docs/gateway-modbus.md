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

### External endpoint
Each PLC's Modbus server is published on one host endpoint, stored as a `RuntimePort`. By default a free loopback port from `RUNTIME_PORT_RANGE` is allocated on first start. `configureModbusEndpoint` sets an explicit bind address and port, validated against the allowed addresses, the port range and every port already published or reserved; it applies on the next start and is refused while a container exists. Inside the factory network other containers use `<service-name>:502`; containers on other networks cannot resolve or reach it.

### Limits
- The runtime's Modbus server does not enforce per-register permissions; see `docs/security.md`.
- The tag registry is not yet checked against the located variables a program declares.
- Gateway tag mappings (`GatewayTagMapping`) belong to Phase 05 and PLC-to-PLC mappings to Phase 07; both reuse the codecs and rules above.
