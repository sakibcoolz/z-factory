# TASK-502 — End-to-End MVP Demo

Status: **DONE**
Linear: [ZFA-19](https://linear.app/recruit-verse/issue/ZFA-19)

## Objective
Demonstrate a complete PLC-authoritative industrial loop with external Modbus interaction.

## Demo chain
```text
sensor/process value -> OpenPLC -> VFD setpoint -> motor -> pump/process
                    -> feedback tags -> external gateway + Z-Factory UI
```

## Acceptance criteria
- Reproducible setup/runbook.
- Factory start/stop lifecycle.
- PLC code executes inside OpenPLC container.
- Multiple factory devices are uniquely named and connected.
- Live topology/tag/runtime state.
- Gateway writes a PLC command/setpoint and reads resulting feedback.
- Setpoint vs actual value is visible.
- At least one interlock/fault scenario.
- Events/alarms/history recorded according to persistence rules.
- PLC engineering export produced for the demo PLC.
- Test evidence and final docs.

## Evidence (2026-10-05)
Two runs of the same scenario: `test/integration/e2e-demo.test.ts` against a real OpenPLC runtime (9 steps, all passing), and by hand in a browser with the production build, following `docs/demo-runbook.md`, with `scripts/edge-client.mjs` as the edge device.

- **Reproducible setup and runbook.** `docs/demo-runbook.md`. In the browser, "Create pump station demo" built the factory and opened its Runtime screen; a second demo is named "Pump Station Demo 2" (tested).
- **Factory start and stop.** "Start factory" brought up the PLC runtime, the simulation of four devices and the gateway endpoint; "Stop factory" (after its confirmation) stopped the simulation and the PLC, and the container exited. Starting or stopping twice changes nothing (tested).
- **PLC code runs inside an OpenPLC container.** The test checks the container is running, the runtime version is recorded and the program version is `DEPLOYED`. The program is built from the tags the wiring created and compiles (checked without Docker too).
- **Uniquely named, connected devices.** `PLC-01`, `VFD-01`, `MOTOR-01`, `PUMP-01`, `PT-101`, `GATEWAY-01`; the drive's seven terminals and the transmitter are wired to channels of the installed modules; drive → motor → pump, transmitter measures the pump, gateway on the PLC's network.
- **Live topology, tags and runtime state.** Browser: Live Tags showed all 12 tags good and live; the 3D view showed PLC, drive, transmitter, motor and pump with green rings and flowing connections, drawn from their catalog assets. The test reads the same states from the live service.
- **Gateway writes a command and a setpoint and reads the feedback.** The edge client wrote `Pump_Speed_SP` 30 and `Pump_Start` true through the endpoint and read 30 Hz actual frequency, the running status and 1.4 bar back. A write to `VFD_01_RUN` was refused.
- **Setpoint and actual value.** `Pump_Speed_SP` (request), `VFD_01_REF` (what the program passed on) and `VFD_01_FREQ` (what the drive does) are three tags; the test catches the drive on its ramp below the setpoint, and Live Tags shows the three side by side.
- **Interlock and fault.** At a setpoint of 48 Hz the program tripped above 3 bar: `High_Pressure_Trip` true, run command gone, frequency 0, with the setpoint and the start command unchanged; the Events screen showed the active alarm. A lower setpoint did not restart the pump; the reset did. In the test an injected drive overcurrent stops the pump, and it runs again after the fault is cleared and reset.
- **Recorded by the persistence rules.** Events screen: gateway commands received and accepted, the refused write, state changes, the alarm. The test checks the event types, both alarms raised and cleared, `DeviceCommand` rows with source `GATEWAY` and no applied time, telemetry sampled (more than 10 rows, far fewer than one per scan), and at most one snapshot per simulated device.
- **Engineering export.** The export screen and `plc.json` (31 kB) for `PLC-01`; the test checks it names the PLC, its model, the devices, the tags and the relationships, and no container id.
- **Tests added:** 13 (4 for the demo factory against PostgreSQL, 9 end-to-end steps against a real OpenPLC runtime).

## Closed (owner's decision, 2026-10-05)
Checked against the code on the owner's request: all eleven acceptance criteria are implemented, and the end-to-end test against a real OpenPLC runtime passes on `develop`.

## Decisions made in this task
- **The demo is an ordinary factory.** It is built by a service that calls the services the screens call, from catalog models. Nothing about it is special afterwards.
- **A modular PLC.** The drive needs an analog output for its speed reference; the compact PLCs of the catalog have none. The CPU 1511-1 PN with four modules gives every terminal a real channel.
- **Factory lifecycle as a service.** `startFactory` and `stopFactory` only sequence the existing operations; no second way to start anything exists.
- **An edge client in the repository.** `scripts/edge-client.mjs` needs Node.js and the register map and imports nothing of the application.
- **Found and fixed on the way:** a gateway connection's port was not counted as reserved, so a PLC started later could have been given it (ports are now reserved, and gateway ports are suggested from the top of the range); the gateway device showed "stopped" while its endpoint was open.
- No schema change, no new variable, no new dependency.

## Not in this task
- A physical edge device in the loop (see TASK-501).
- The drive fault scenario was run by the test, not clicked through in the browser.
- A unit and finer resolution for `PT_101_OUT`: it is the raw analog input as wiring creates it (0.1 bar, no unit).
- Opening gateway endpoints at server start.

