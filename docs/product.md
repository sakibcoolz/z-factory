# Product Definition

## Name
Z-Factory

## Goal
Create a browser-first virtual industrial factory where users can configure simulated PLCs and industrial devices, launch them in Docker, connect them through virtual networks, inspect live tags/events, visualize topology/3D state, and allow external edge devices such as Raspberry Pi gateways to communicate with the simulation.

## MVP
- Next.js SSR/full-stack UI and server functionality.
- Factory CRUD and factory runtime lifecycle.
- OpenPLC runtime.
- Modbus TCP.
- PLC/device catalog with compact vs modular hardware models.
- Tags, I/O channels, racks, slots, modules, and connections.
- Docker network/container orchestration.
- React Flow topology.
- Three.js/React Three Fiber 3D visualization.
- Events and live telemetry.
- Exposed host ports for an external Raspberry Pi gateway.

## Explicitly out of MVP
- Exact Siemens/Rockwell/Schneider firmware emulation.
- TIA Portal or Studio 5000 compatibility.
- PROFINET/EtherCAT timing-accurate simulation.
- Full electrical physics.
- Cloud/SCADA product integration.

## Primary demo
Sensor -> OpenPLC -> VFD simulation -> motor/pump visualization, with Raspberry Pi reading/writing Modbus TCP through the Docker host.
