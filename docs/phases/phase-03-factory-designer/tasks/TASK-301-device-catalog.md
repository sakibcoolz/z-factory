# TASK-301 — Device Catalog & Provenance

Status: **DONE**
Linear: [ZFA-12](https://linear.app/recruit-verse/issue/ZFA-12)

## Objective
Populate normalized PLC and industrial peripheral profiles from authoritative sources and seed generic categories needed by the factory designer.

## Initial PLC targets
- Siemens S7-1200 CPU 1214C DC/DC/DC
- Siemens S7-1500 CPU 1511-1 PN
- Rockwell CompactLogix 5380 5069-L306ER
- Schneider Modicon M241

## Peripheral categories
Field/process devices include VFDs/drives, motors, pumps, fans/blowers, conveyors, mixers, compressors, valves, actuators, relays/contactors, switches, heaters, encoders and temperature/pressure/level/flow/proximity/photoelectric/vibration/current/voltage/position sensors.

## Industrial control / intermediate device categories
The catalog must also support devices that commonly sit between PLC logic and field equipment or aggregate remote signals:
- VFD / variable-frequency drive
- servo drive
- soft starter
- motion controller
- PID / process controller
- temperature controller
- robot/controller interface
- safety relay and safety-controller metadata (simulation only; not safety-rated)
- remote I/O / distributed I/O
- IO-Link master
- protocol converter / industrial gateway
- signal conditioner / isolator
- analog transmitter / converter
- motor starter / intelligent motor protection relay where applicable
- industrial edge gateway
- HMI/SCADA endpoint metadata where needed

Some controllers are programmable/configurable; others are parameter-driven. Runtime behavior must be declared by model capability and never inferred only from category.

## Relationship examples
```text
PLC -> VFD -> Motor -> Pump
PLC -> Servo Drive -> Servo Motor
PLC -> Remote I/O -> Sensors / Valves
PLC -> Temperature Controller -> Heater
PLC -> Gateway / Protocol Converter -> External Device Network
```

An intermediate device is not mandatory in every connection. Many sensors/switches may connect directly to PLC I/O.

## Acceptance criteria
- Model and factory instance concepts remain separate.
- For verified vendor records capture exact model/SKU, documented electrical/comms/I/O/register facts, source URL/revision/date and verification timestamp.
- Device category records capture simulator/control relationship metadata such as requiresMotor/requiresDrive/preferredDriveType.
- Catalog metadata can describe direct PLC I/O, smart/protocol device, configurable controller and programmable-controller capability.
- Compatibility metadata supports PLC I/O and protocol filtering.
- Device relationship rules can represent controller/drive/remote-I/O chains without forcing an intermediate device where none exists.
- Never invent pinouts/register maps or copy full manuals into the repository.

## Evidence (2026-10-05)
- **Model and instance stay separate.** Catalog models are reference data written by `npm run db:seed`; factory device instances are created from them and never change them (integration test).
- **Verified vendor records with provenance.** The four PLC targets and eight I/O modules carry exact order numbers, supply, ports, channel counts and signal types, each with source URL, title, revision, retrieval date and verification date. Sources: `docs/references/catalog-sources.md`. A record without complete provenance is rejected before it reaches the database.
- **Category relationship metadata.** 35 categories with simulator type, `requiresMotor`, `requiresDrive` and `preferredDriveType`.
- **Control capability per model.** `controlCapability` (direct I/O, parameter-configured, protocol-controlled, programmable) and `runtimeSupport` are set per model; the generic VFD exists in a hardwired and a Modbus TCP variant.
- **I/O and protocol filtering.** `listCompatiblePeripherals` matches terminals to built-in channels (compact, with channel counts) or installable modules (modular), and ports by shared protocol.
- **Chains without a forced intermediate device.** PLC → VFD → motor → pump, PLC → servo drive → servo motor, PLC → remote I/O → valve, PLC → temperature controller → heater and sensor → PLC are all created in one integration test; a servo motor refuses a VFD.
- **Nothing invented.** Terminal labels and address hints only where the source prints them; no register maps, fault codes or pinouts for vendor devices; Modbus TCP is claimed only where the source states it (not for the 5069-L306ER).
- Tests: 18 catalog definition and rule tests, 13 compatibility and drive-rule tests, 5 catalog screen tests, 11 integration tests against PostgreSQL. 387 tests pass with the database and Docker tests enabled; format check, lint, typecheck and build pass.

## Decisions made in this task
- "Modicon M241" is a family; the record is the **TM241CE24T**.
- The CPU 1511-1 PN record is the **6ES7511-1AK02-0AB0**, the revision the retrievable equipment manual documents.
- A signal whose range lies inside a range the channel supports is treated as fitting (a ±10 V input carries 0–10 V). This is a Z-Factory rule, not a vendor statement.

## Schema changes
- `DeviceModel.controlCapability` (new enum `ControlCapability`), `BuiltInIoChannel.acceptedSignalTypes`, `ModuleChannel.acceptedSignalTypes` (migration `catalog_capabilities`).
- `DeviceIoDefinition.simulatorSignal` (migration `device_io_simulator_signal`).

## Not in this task
- Lifecycle status, slot rules and power-supply modules are not recorded.
- Expansion of compact PLCs (S7-1200 signal modules, M241 TM3 modules) is not modelled.
- No vendor peripheral records (drives, sensors); peripherals are generic simulated models.
- The S7-1200 facts come from the 01/2015 Easy Book; Siemens data sheets and Schneider product pages refused automated retrieval.
- The catalog screen has no search and no "Use in factory" action.
