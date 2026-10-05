# ADR 0013 — External Gateways Connect to a Filtering Modbus Endpoint

Status: Accepted — 2026-10-05 (implemented in TASK-501; accepted by the owner)

## Context
ADR-0006 decides that an external gateway writes PLC command and setpoint tags over Modbus TCP and never anything else. TASK-203 published each PLC's own Modbus server on a host port and recorded its limit in `docs/security.md`: the OpenPLC runtime's Modbus server has no permissions per register. A client that reaches that port can write any coil or holding register, including the feedback and status values PLC logic and the device simulator produce, and can read every register of the PLC. Typed tag access through Z-Factory enforces the rules; a physical edge device speaking plain Modbus does not go through it.

TASK-501 has to let such a device on the LAN reach a PLC while "writes target PLC command/setpoint tags only". Three ways were possible:

- **Publish the PLC's own port on the LAN** and document the limit. No new code, and the criterion is not met: the rule would rest on the gateway behaving.
- **A proxy container per factory.** Enforces the rule, but adds an image, a container lifecycle and a second place that has to know the tag registry.
- **An endpoint in the server process.** The server already holds the tag registry, the write path with its command records and events, and two in-process runtimes of the same kind (device simulator, ADR-0010; tag monitor, ADR-0011).

## Decision
1. **A gateway never talks to a PLC's Modbus server.** It talks to a gateway endpoint: a Modbus TCP listener Z-Factory opens for one gateway connection (`lib/runtimes/gateway-endpoint/`, `lib/protocols/modbus/server.ts`). The PLC's own port stays on loopback.
2. **The endpoint hands out what was mapped, at the PLC's own addresses.** A gateway connection (`GatewayPlcConnection`) names the host address, port and unit id of the endpoint; its mappings (`GatewayTagMapping`) name the tags the gateway is given. A mapped tag appears at the Modbus area and address it has in the PLC, so the register map a gateway is configured from is the PLC's map with everything else left out.
3. **Reads are passed through, writes become tag writes.** A read whose every address is mapped is forwarded to the PLC as it is. A write is allowed only when it covers whole values that are mapped as writable, and a mapping can be writable only for a `COMMAND` or `SETPOINT` tag. An allowed write goes through `writeTag` with source `GATEWAY`: it is range-checked, stored as a `DeviceCommand` and recorded as `GATEWAY_COMMAND_RECEIVED` and `COMMAND_ACCEPTED` or `COMMAND_FAILED`.
4. **Everything else is refused before the PLC is asked**, with Modbus exception 02 (illegal data address): unmapped addresses, a range that bridges an unmapped gap, a write to a read-only mapping, half of a two-word value. A refused write is recorded as `COMMAND_REJECTED` (the same refusal at most once in 30 seconds). Functions other than 1, 2, 3, 4, 5, 6, 15 and 16 answer exception 01; another unit id answers 0A; a PLC that cannot be reached answers 0B.
5. **Where it may listen is host policy.** The address must be one of `RUNTIME_BIND_ADDRESSES`, the port inside `RUNTIME_PORT_RANGE` and not published by a container, reserved for a PLC, or used by another gateway connection.
6. **Lifetime.** Endpoints live in the server process. They are opened from the stored connections when a gateway is configured and whenever the factory's gateway screen is read, so they return after a server restart the same way tag monitoring does.

## Consequences
- **The write rule is enforced, not requested.** A gateway on the network cannot set a feedback value, read an unmapped register or sweep the PLC, whatever software it runs. The closed loop is proven against a real OpenPLC runtime: an edge client changes a setpoint through the endpoint, the program passes it to the drive, and the client reads the result back.
- **One server process.** Like the simulator and the tag monitor, endpoints are process state. Several server instances would each try to open the same ports; that needs a decision of its own.
- **Not available until a screen is opened after a restart.** Until then nothing listens and a gateway sees a refused connection. Opening endpoints at server start needs a start-up hook the application does not have yet.
- **No authentication of the device.** Modbus TCP has none. Who may connect is decided by the bind address and the host firewall; the endpoint limits what a connected client can do, not who it is. A connection is limited to 4 clients and closed after 2 minutes of silence.
- **Latency and load.** Every request is one more hop, and every read is forwarded as one request to the PLC. That suits polling at the intervals an edge gateway uses, not fast scanning.
- **Raw values.** The gateway reads and writes the PLC's raw register values; scale, offset and unit are in the register map it is given. Renaming a tag for the gateway (`externalName`) changes the name in that map, not the address.
- **The PLC's own port keeps its limit.** Publishing it beyond loopback remains possible through `configureModbusEndpoint` and remains unprotected; the gateway endpoint is the supported way for an external device.
