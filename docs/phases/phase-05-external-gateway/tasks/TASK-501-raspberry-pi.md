# TASK-501 — Industrial Edge / Raspberry Pi Connectivity

Status: **DONE**
Linear: [ZFA-18](https://linear.app/recruit-verse/issue/ZFA-18)

## Objective
Allow a physical industrial edge gateway/Raspberry Pi on the LAN to reach selected PLC endpoints through controlled Docker-host published ports.

## Acceptance criteria
- Network prerequisites documented.
- Bind address configurable.
- Port/firewall guidance.
- Gateway connection stores PLC host/port/unit ID/polling/mapping metadata.
- Modbus read/write verification from edge client.
- Writes target PLC command/setpoint tags only.
- Feedback/status values can be read back.
- Command request and actual device result remain distinguishable.
- No Docker socket/API exposed to edge client.

## Evidence (2026-10-05)
- **Network prerequisites, port and firewall guidance.** `docs/gateway-modbus.md` → Network prerequisites: the address to add to `RUNTIME_BIND_ADDRESSES`, the port range, firewall rules for one device (firewalld and ufw), what must stay closed, and a `pymodbus` check to run on the device.
- **Bind address configurable.** A connection is opened on one of the addresses the host allows. In the browser, with `RUNTIME_BIND_ADDRESSES=127.0.0.1,192.168.0.103`, an endpoint was opened on `192.168.0.103:15000`; a client reached it on that address and was refused on `127.0.0.1`. An address outside the list, a port outside the range and a port already published or reserved are refused (tested).
- **Connection metadata.** `GatewayPlcConnection` stores host, port, unit id, poll interval and whether the endpoint is open; `GatewayTagMapping` the tags, the name for the gateway and the access. The register map download carries them for the edge device.
- **Modbus read and write from an edge client.** A standalone Modbus client (its own process, knowing only address, port and unit id) against the endpoint the browser opened: an unmapped register and a sweep of 125 registers were refused (exception 02), writes to two feedback tags and to an unmapped coil were refused, a diagnostics function was refused (01), another unit id was refused (0A). The PLC of that check was not started, so mapped requests answered 0B; mapped reads returning the PLC's values and accepted writes are shown by the tests with a stand-in PLC and by the closed loop against a real OpenPLC runtime below.
- **Writes target command and setpoint tags only.** Granting write access to a feedback, status or alarm tag is refused when mapping; the endpoint refuses a write to anything but a writable mapping before the PLC is asked, and a test checks that the PLC's registers did not change. Against a real OpenPLC runtime, writes through the endpoint to what the program drives and to what the devices answer were refused.
- **Feedback can be read back; request and result stay distinguishable.** Against a real OpenPLC runtime with the device simulation running, an edge client wrote a 25 Hz setpoint through the endpoint; the program passed it to the drive, the drive ramped, and the client read 25 Hz actual frequency back through the endpoint. The write is a `DeviceCommand` with source `GATEWAY`, status `ACCEPTED` and no applied time: what the device did is read from feedback.
- **No Docker socket or API for the edge client.** The device reaches one TCP listener that speaks eight Modbus functions. The register map names the endpoint and the mapped tags; a test checks it carries no container id or management port.
- **Recorded.** Gateway commands (`GATEWAY_COMMAND_RECEIVED`, `COMMAND_ACCEPTED`), refused writes (`COMMAND_REJECTED` with the rule, once per 30 seconds for the same refusal) and a device's arrival and leaving. Reads are not events.
- **Tests added:** 30 (15 unit: access rules, Modbus server, endpoint; 11 against PostgreSQL with a stand-in PLC and a real TCP client; 3 for the screen; 1 against a real OpenPLC runtime).

## Decisions made in this task
- **ADR-0013 (accepted by the owner):** an external gateway connects to a filtering Modbus endpoint in the server process, not to the PLC's own Modbus port, which cannot enforce permissions. It is the only one of the two designs considered that meets "writes target command/setpoint tags only"; the other was publishing the PLC's own port and documenting the gap.
- **Same addresses as the PLC.** A mapped tag keeps its Modbus area and address, so the gateway's map is the PLC's map with the rest left out.
- **A device is a visit, not a connection.** Found in the browser check: a client that opens a connection per request was recorded once per request. It is now recorded when it first appears and after 15 seconds of silence.
- **No schema change.** The gateway tables existed since TASK-102. No new variable, no new dependency.
- **A screen without a wireframe.** `/factories/[factoryId]/gateways` follows the shell's conventions; `docs/design.md` describes it.

## Closed (owner's decision, 2026-10-05)
Checked against the code on the owner's request: every acceptance criterion is implemented and covered by tests, including the closed loop against a real OpenPLC runtime, so the task is closed. The check with a physical edge device on the LAN has not been run; it remains the owner's to do with `docs/gateway-modbus.md` → Checking from the edge device.

## Not in this task
- **A physical edge device.** No Raspberry Pi was available to the session. The check from a real device on the LAN is described in `docs/gateway-modbus.md` and is the owner's to run.
- Opening endpoints at server start: they are opened when the Gateways screen is read or a gateway is configured.
- Editing a connection in place, per-device authentication, rate limits, TLS.
- The end-to-end demo with the gateway in the loop on screen: TASK-502.

