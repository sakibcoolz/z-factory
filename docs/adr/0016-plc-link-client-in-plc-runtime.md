# ADR-0016 — PLC-to-PLC Client Runs in the Client PLC's Runtime

Status: **ACCEPTED** (TASK-703, 2026-10-06)

## Context
Phase 07 links two PLCs of a factory: one is the Modbus TCP client of the other's server
(TASK-701, TASK-702). The exchange has to run on the isolated factory Docker network, by the
server's service name, without host-published ports, and a failing link must not affect other
runtimes. Three places could run the client:

1. **A client in the Z-Factory server process**, polling one PLC and writing the other. The
   server process is not on any factory network, so it would go through host-published ports;
   it would put Z-Factory in the control path between two PLCs; and every value would cross
   the host twice.
2. **A link sidecar container per factory** on the factory network. It reaches PLCs by name,
   but adds an image, a lifecycle and a component that writes a PLC from outside its program.
3. **The client PLC's own runtime as Modbus master.** The OpenPLC Runtime v4 image Z-Factory
   already runs ships a Modbus master plugin (`core/src/drivers/plugins/python/modbus_master`),
   enabled per deployment by `conf/modbus_master.json` in the program bundle.

## Decision
Option 3. The client PLC's runtime is the Modbus master of its links. Deploying a PLC's
program also deploys its enabled links as the plugin's configuration: one device per link
(the server's service name, port, unit id, timeout), one point per enabled mapping (function
code by area and direction, the server's register, the client's located address, the interval).

This is how a supervisory PLC polls a machine PLC in a plant: the communication is part of
the controller's configuration and runs in its scan environment, not in an outside service.

## Consequences
- Traffic runs container to container on the factory network; no host port, no Z-Factory
  process in the path; a PLC of another factory is unreachable by network as well as by rule.
- A failing link affects only its client's plugin thread; the master keeps the last value of a
  READ and retries on its own connection manager.
- A link change takes effect at the client's next deployment. The deployment snapshot records
  the link versions it carries, and the link monitor shows the link as STALE until then.
- The mapping rules follow what the plugin carries (`plc-link-adapter`): raw bits and words,
  same type and scaling at both ends, BOOL/INT16/UINT16 (its 32-bit word order differs from the
  server's), bits in `%IX`/`%QX`.
- Z-Factory only observes: `PlcLinkMonitorRuntime` probes the server and compares deployed
  link versions, and records connection events. It never writes a PLC on a link's behalf.
- Another runtime adapter (a physical target) supplies its own way of being a Modbus client;
  the link and mapping model does not change.
