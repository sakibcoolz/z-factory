# MVP Demo Runbook — Pump Station

The end-to-end demonstration of Z-Factory (TASK-502): a PLC-authoritative control loop with an external gateway in it.

```text
PT-101 pressure --> PLC-01 (OpenPLC, program pump_station) --> VFD-01 --> MOTOR-01 --> PUMP-01
     ^                         ^   |                                                      |
     |                         |   +-- feedback, status, alarm tags                       |
     +---- pressure follows the pump's speed (device simulation) -------------------------+
                               |
GATEWAY-01 endpoint <--> edge client: writes Pump_Start, Pump_Reset, Pump_Speed_SP; reads everything else
```

The gateway and the operator only ask. The program decides: it limits the speed to 50 Hz, stops the drive on a drive fault, and trips above 3 bar until it is reset.

## What you need
- The development setup of `README.md`: Node.js 22, Docker, `npm install`, `npm run db:up`, `npm run db:migrate`, `npm run db:seed` (the demo is built from the seeded catalog).
- The server: `npm run dev`, or `npm run build` and `LOCAL_OWNER_ID=local-owner RUNTIME_SECRET=<32 or more characters> npm start`.
- The first start of a PLC downloads the OpenPLC runtime image (about 360 MB).
- For an edge device on another machine: its address allowed as described in `docs/gateway-modbus.md` → Network prerequisites. On the same machine nothing is needed.

## 1. Create the factory
Factories → New factory → **Create pump station demo**. The runtime screen of "Pump Station Demo" opens. Nothing runs yet.

What was created, all of it changeable on the usual screens:

| Device | Catalog model | Connected |
|---|---|---|
| `PLC-01` | Siemens CPU 1511-1 PN with DI 16, DQ 16, AI 8 and AQ 4 modules | runs the program `pump_station` |
| `VFD-01` | Generic VFD, hardwired control | seven terminals wired to PLC channels; drives `MOTOR-01` |
| `MOTOR-01` | Generic three-phase motor | drives `PUMP-01` |
| `PUMP-01` | Generic centrifugal pump | 4 bar at 50 Hz, pressure with the square of the speed |
| `PT-101` | Generic pressure transmitter, 4–20 mA | wired to an analog input; measures `PUMP-01` |
| `GATEWAY-01` | Generic Modbus TCP gateway | endpoint on `127.0.0.1`, highest free port of the range; every tag mapped |

Tags an operator or a gateway may write: `Pump_Start`, `Pump_Reset` (commands), `Pump_Speed_SP` (setpoint, Hz). Everything else is produced by the program or the field: `VFD_01_RUN`, `VFD_01_REF`, `VFD_01_FREQ`, `VFD_01_RUNNING`, `VFD_01_FAULT`, `PT_101_OUT` (bar), `High_Pressure_Trip`.

## 2. Start the factory
Runtime → **Start factory**. It starts the PLC runtime (a container; the program is built inside it), then the device simulation, then the gateway endpoint. The first start takes a minute or two. The screen then shows the PLC running and the simulation running.

## 3. Get the edge client its register map
Gateways → **Register map for the gateway (JSON)**, saved as `map.json`. It names the endpoint, the unit id and every mapped tag.

`scripts/edge-client.mjs` stands in for an edge device. It needs Node.js and that file, nothing else, so it can be copied to a Raspberry Pi. For a device on the network, connect the gateway on the host's LAN address first (`docs/gateway-modbus.md`).

```bash
node scripts/edge-client.mjs map.json read
```

Before the start every line says that the PLC does not answer. After it, all values are 0 or false.

## 4. Run the pump from the gateway
```bash
node scripts/edge-client.mjs map.json write Pump_Speed_SP 30
node scripts/edge-client.mjs map.json write Pump_Start true
node scripts/edge-client.mjs map.json watch 15
```

- **Setpoint and actual value are different things.** `Pump_Speed_SP` is 30 at once; `VFD_01_REF` follows when the program passes it on; `VFD_01_FREQ` ramps for about 2.4 seconds; `PT_101_OUT` settles at 1.4 bar.
- **Live Tags** shows the same values with their roles; **Designer** and **3D** show PLC, drive, motor, pump and transmitter running and the connections flowing; **Events** lists `GATEWAY_COMMAND_RECEIVED` and `COMMAND_ACCEPTED` for both writes, then the state changes of the drive, motor and pump.
- **The gateway cannot do more than it was given:**

```bash
node scripts/edge-client.mjs map.json write VFD_01_RUN false     # refused: mapped for reading only
```

## 5. Interlock: high pressure
```bash
node scripts/edge-client.mjs map.json write Pump_Speed_SP 48     # would be 3.7 bar
node scripts/edge-client.mjs map.json read
```

Above 3 bar the program sets `High_Pressure_Trip` and takes the run command from the drive. The setpoint is still 48 and `Pump_Start` still true: the request stands, the result differs. **Events** shows the alarm "High_Pressure_Trip is active"; the status bar turns red.

A lower setpoint alone does not restart a tripped pump. The reset does:

```bash
node scripts/edge-client.mjs map.json write Pump_Speed_SP 30
node scripts/edge-client.mjs map.json write Pump_Reset true
node scripts/edge-client.mjs map.json write Pump_Reset false
```

The pump runs at 30 Hz again and the alarm is cleared.

## 6. Fault: drive overcurrent
Simulator → `VFD-01` → **Inject overcurrent**. The drive trips; the program sees `VFD_01_FAULT` and stops asking it to run. The 3D view shows the drive and its connections in red, **Events** the alarm `FAULT:OVERCURRENT`.

**Clear overcurrent**, then reset from the gateway as in step 5. A latching fault stays until the drive is reset; the program passes `Pump_Reset` on to the drive.

## 7. Engineering export
PLC-01 → Export: the report with identity, modules and channels, tags, Modbus map, connected devices, relationships and versions; downloads as JSON and CSV. "Open printable report" prints it.

## 8. Stop
Runtime → **Stop factory**. The simulation stops first and stores the last device states, then the PLC. The edge client is told again that the PLC does not answer. The factory, its program and its history stay; "Start factory" runs it again. To remove it, delete the stopped factory: its PLC containers and its Docker network are removed with it.

## What is recorded
- Every gateway write: a `DeviceCommand` with source `GATEWAY`, and the events `GATEWAY_COMMAND_RECEIVED` and `COMMAND_ACCEPTED`. A refused write: `COMMAND_REJECTED`.
- State changes of the simulated devices, injected and cleared faults, alarms with the time they were raised and cleared.
- Telemetry of every tag, sampled on change and at most once a second; not every scan.
- One snapshot per simulated device, overwritten every 10 seconds and when the simulation stops.

## The same run as a test
`test/integration/e2e-demo.test.ts` does steps 1 to 8 against a real OpenPLC runtime with an edge client at the gateway endpoint: `TEST_DOCKER=1 npm test` with `TEST_DATABASE_URL` set. `test/integration/demo-factory.test.ts` checks what step 1 builds without Docker.

## Limits of the demo
- The models are approximations for testing control software (`docs/device-simulation.md`): a linear drive ramp, a first-order motor, pump affinity laws against a fixed system.
- `PT_101_OUT` has a resolution of 0.1 bar and no unit on the Live Tags screen: it is the raw analog input as wiring creates it.
- The gateway endpoint of the demo listens on this machine only. An edge device on the network needs a connection on the host's LAN address.
- Not run with a physical edge device yet.
