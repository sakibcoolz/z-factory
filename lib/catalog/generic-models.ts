/**
 * Generic, simulated device models. They make no vendor claim: terminals and signal
 * types are common industrial conventions chosen so the designer and the simulator have
 * something to work with. They carry the GENERIC status and no order number.
 */
import { type CatalogInput, GENERIC_MANUFACTURER } from "@/lib/catalog/schema";

type Model = NonNullable<CatalogInput["models"]>[number];
type Terminal = NonNullable<Model["terminals"]>[number];

const generic = (
  category: string,
  family: string,
  modelName: string,
  options: Partial<
    Pick<
      Model,
      | "controlCapability"
      | "capabilities"
      | "runtimeSupport"
      | "terminals"
      | "ports"
      | "faults"
      | "electrical"
      | "architectureType"
      | "builtInChannels"
    >
  > = {},
): Model => ({
  manufacturer: GENERIC_MANUFACTURER,
  category,
  family,
  modelName,
  runtimeSupport: "DEVICE_SIM",
  controlCapability: "DIRECT_IO",
  verification: { status: "GENERIC" },
  ...options,
});

/** A 24 V DC signal the PLC drives (device input) or reads (device output). */
const digital = (terminalLabel: string, direction: "INPUT" | "OUTPUT", simulatorSignal?: string): Terminal => ({
  terminalLabel,
  direction,
  ioType: "DIGITAL",
  signalType: "DC_24V",
  simulatorSignal,
});

const analog = (
  terminalLabel: string,
  direction: "INPUT" | "OUTPUT",
  signalType: "CURRENT_4_20MA" | "VOLTAGE_0_10V",
  simulatorSignal?: string,
): Terminal => ({ terminalLabel, direction, ioType: "ANALOG", signalType, simulatorSignal });

const DC_24V = { supplyType: "DC", nominalVoltage: 24 } as const;

/** Supply terminals of a 24 V DC field device: it takes the supply and has a 0 V terminal. */
const SUPPLY_24V: Terminal[] = [
  { terminalLabel: "+24V", kind: "POWER", direction: "INPUT", signalType: "DC_24V" },
  { terminalLabel: "0V", kind: "COMMON" },
];

/** A transmitter with one analog output carrying the measured value. */
const transmitter = (modelName: string, signalType: "CURRENT_4_20MA" | "VOLTAGE_0_10V") =>
  generic("SENSOR", "Generic transmitters", modelName, {
    terminals: [analog("OUT", "OUTPUT", signalType, "value"), ...SUPPLY_24V],
    faults: ["BAD_QUALITY", "STUCK"],
    electrical: DC_24V,
  });

/** A device with one 24 V DC contact the PLC reads. */
const contact = (category: string, family: string, modelName: string) =>
  generic(category, family, modelName, { terminals: [digital("OUT", "OUTPUT", "state")], faults: ["STUCK"] });

const ETHERNET_MODBUS = [{ name: "Ethernet", physicalType: "Ethernet", protocols: ["MODBUS_TCP" as const] }];

export const genericModels: CatalogInput = {
  manufacturers: [{ name: GENERIC_MANUFACTURER }],
  models: [
    generic("VFD", "Generic drives", "Generic VFD, hardwired control", {
      controlCapability: "PARAMETER_CONFIGURED",
      capabilities: ["PARAMETER_CONFIGURABLE", "LOCAL_CONTROL"],
      terminals: [
        digital("RUN", "INPUT", "run"),
        digital("REV", "INPUT", "reverse"),
        digital("RESET", "INPUT", "faultReset"),
        analog("REF", "INPUT", "VOLTAGE_0_10V", "frequencySetpoint"),
        digital("RUNNING", "OUTPUT", "running"),
        digital("FAULT", "OUTPUT", "faulted"),
        analog("FREQ", "OUTPUT", "VOLTAGE_0_10V", "actualFrequency"),
        // Reference potential of the control terminals, and the earth terminal of the housing.
        { terminalLabel: "COM", kind: "COMMON", maxConnections: 4 },
        { terminalLabel: "PE", kind: "EARTH" },
      ],
      faults: ["OVERCURRENT", "OVERTEMPERATURE"],
    }),
    // Commanded over the network. Not executable yet: the simulator has no Modbus device side.
    generic("VFD", "Generic drives", "Generic VFD, Modbus TCP", {
      controlCapability: "PROTOCOL_CONTROLLED",
      capabilities: ["PARAMETER_CONFIGURABLE", "REMOTE_CONTROL", "MODBUS_SERVER"],
      runtimeSupport: "NONE",
      ports: ETHERNET_MODBUS,
    }),
    generic("MOTOR", "Generic motors", "Generic three-phase motor", {
      terminals: [digital("K1", "INPUT", "run"), digital("K1 AUX", "OUTPUT", "running")],
      faults: ["OVERLOAD"],
    }),
    generic("PUMP", "Generic pumps", "Generic centrifugal pump", { faults: ["DRY_RUN"] }),
    generic("FAN", "Generic fans", "Generic fan"),
    generic("CONVEYOR", "Generic conveyors", "Generic belt conveyor"),
    generic("MIXER", "Generic mixers", "Generic agitator"),
    generic("COMPRESSOR", "Generic compressors", "Generic compressor"),
    generic("VALVE", "Generic valves", "Generic on/off valve, 24 V DC", {
      terminals: [
        digital("Y1", "INPUT", "open"),
        digital("ZSO", "OUTPUT", "opened"),
        digital("ZSC", "OUTPUT", "closed"),
      ],
      faults: ["STUCK"],
    }),
    generic("VALVE", "Generic valves", "Generic control valve, 4–20 mA", {
      terminals: [
        analog("POS REF", "INPUT", "CURRENT_4_20MA", "positionSetpoint"),
        analog("POS FB", "OUTPUT", "CURRENT_4_20MA", "position"),
      ],
      faults: ["STUCK"],
    }),
    transmitter("Generic pressure transmitter, 4–20 mA", "CURRENT_4_20MA"),
    transmitter("Generic pressure transmitter, 0–10 V", "VOLTAGE_0_10V"),
    transmitter("Generic temperature transmitter, 4–20 mA", "CURRENT_4_20MA"),
    transmitter("Generic level transmitter, 4–20 mA", "CURRENT_4_20MA"),
    transmitter("Generic flow transmitter, 4–20 mA", "CURRENT_4_20MA"),
    contact("SWITCH", "Generic switches", "Generic push button, 24 V DC"),
    contact("SWITCH", "Generic switches", "Generic limit switch, 24 V DC"),
    contact("SWITCH", "Generic switches", "Generic float switch, 24 V DC"),
    contact("SWITCH", "Generic switches", "Generic pressure switch, 24 V DC"),
    contact("PROXIMITY_SENSOR", "Generic proximity sensors", "Generic proximity sensor, 24 V DC PNP"),
    // A programmable RTU: the same program, version and runtime workflow as a PLC, on the OpenPLC adapter.
    generic("RTU", "Generic RTUs", "Generic RTU, IEC 61131-3", {
      controlCapability: "PROGRAMMABLE",
      capabilities: ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER", "REMOTE_CONTROL", "DATA_LOGGING"],
      runtimeSupport: "OPENPLC",
      architectureType: "COMPACT",
      ports: ETHERNET_MODBUS,
      builtInChannels: [
        { ioType: "DI", count: 8, signalType: "DC_24V" },
        { ioType: "DO", count: 4, signalType: "DC_24V" },
        { ioType: "AI", count: 4, signalType: "CURRENT_4_20MA", acceptedSignalTypes: ["CURRENT_0_20MA"] },
      ],
      electrical: DC_24V,
    }),
    // Distribution: the terminals that are shared, each within the number of wires it takes.
    generic("POWER_SUPPLY", "Generic power supplies", "Generic 24 V DC power supply", {
      runtimeSupport: "NONE",
      terminals: [
        { terminalLabel: "+24V", kind: "POWER", direction: "OUTPUT", signalType: "DC_24V", maxConnections: 8 },
        { terminalLabel: "0V", kind: "COMMON", maxConnections: 8 },
        { terminalLabel: "PE", kind: "EARTH", maxConnections: 8 },
      ],
      electrical: DC_24V,
    }),
    // Not simulated yet: there is no behaviour model for these categories.
    generic("CONTACTOR", "Generic contactors", "Generic contactor, 24 V DC coil", {
      runtimeSupport: "NONE",
      terminals: [digital("A1", "INPUT"), digital("AUX", "OUTPUT")],
    }),
    generic("HEATER", "Generic heaters", "Generic heater, contactor-switched", {
      runtimeSupport: "NONE",
      terminals: [digital("ON", "INPUT")],
    }),
    generic("INDICATOR", "Generic indicators", "Generic stack light, 24 V DC", {
      runtimeSupport: "NONE",
      terminals: [digital("RED", "INPUT"), digital("YELLOW", "INPUT"), digital("GREEN", "INPUT")],
    }),
    generic("TEMPERATURE_CONTROLLER", "Generic controllers", "Generic temperature controller", {
      controlCapability: "PARAMETER_CONFIGURED",
      capabilities: ["PARAMETER_CONFIGURABLE", "LOCAL_CONTROL"],
      runtimeSupport: "NONE",
      terminals: [digital("ENABLE", "INPUT"), digital("ALARM", "OUTPUT"), analog("PV", "OUTPUT", "CURRENT_4_20MA")],
    }),
    generic("REMOTE_IO", "Generic remote I/O", "Generic remote I/O station, Modbus TCP", {
      controlCapability: "PROTOCOL_CONTROLLED",
      capabilities: ["REMOTE_IO", "MODBUS_SERVER"],
      runtimeSupport: "NONE",
      ports: ETHERNET_MODBUS,
    }),
    generic("GATEWAY", "Generic gateways", "Generic Modbus TCP gateway", {
      controlCapability: "PROTOCOL_CONTROLLED",
      capabilities: ["MODBUS_CLIENT", "MODBUS_SERVER"],
      runtimeSupport: "NONE",
      ports: ETHERNET_MODBUS,
    }),
  ],
};
