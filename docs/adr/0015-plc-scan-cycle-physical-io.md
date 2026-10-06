# ADR-0015 — PLC Scan-Cycle Authority and Physical I/O Boundary

Status: **ACCEPTED**

## Context
Z-Factory uses OpenPLC plus Modbus TCP for simulation and external integration. This can create a misleading impression that Modbus writes should directly drive PLC output pins.

That is not the intended industrial model. In a real PLC, the control program executes its scan cycle, reads process inputs and writes the controller's local outputs. External protocols such as Modbus may provide commands, setpoints, peer data or remote I/O, but they are not the default mechanism for a PLC program's own local physical output image.

## Decision
The PLC program is authoritative for local outputs.

### Simulation
- Simulated field inputs may be injected into the virtual PLC through a simulation bridge.
- The PLC program reads those simulated inputs and computes outputs.
- The PLC program writes output variables such as `%QX` / `%QW`.
- Device simulators observe those program-driven outputs and produce feedback/process inputs.
- Modbus is a transport/inspection bridge in simulation; it is not the owner of the PLC output pin.

### External command path
Remote UI/gateway writes only command/setpoint/internal communication tags explicitly intended for external writes.

```text
Gateway/UI
 -> command/setpoint memory/tag
 -> PLC scan-cycle logic
 -> local PLC output
 -> field device
```

External writes must not directly force a local physical output merely because its runtime representation is Modbus-addressable.

### Physical PLC target
When deploying equivalent logic to a physical PLC:
- the vendor/target runtime maps logical I/O to the controller's real I/O modules/channels;
- the PLC scan cycle reads real inputs and writes real outputs locally;
- no Modbus connection is required for local physical I/O unless the plant design intentionally uses Modbus remote I/O or a Modbus field device;
- Z-Factory's logical program and canonical wiring remain separate from the target-specific physical address/deployment adapter.

## Consequences
- Program logic, logical I/O, canonical wiring, external protocol tags and target-specific physical I/O mapping remain separate concepts.
- UI must distinguish **command/setpoint write**, **forced/test I/O**, and **program-driven output**.
- Direct output forcing is a special diagnostic/test operation, never the normal control path, and is out of scope until explicitly designed with permissions and safety warnings.
- Existing Modbus code may still read output state and carry simulator values, but application services must not present direct Modbus writes to output pins as normal production control.
