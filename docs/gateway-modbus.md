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

## Address mapping of the OpenPLC runtime (ADR-0008)
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
