/**
 * Schneider Electric catalog records. Every value below was read from the Schneider
 * document named in the record's `source`. Values the document does not state, or that
 * were not checked, are left out rather than filled in.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import { driveFeatures, PLC_CAPABILITIES, PLC_SIMULATION } from "@/lib/catalog/capabilities";

const RETRIEVED = "2026-10-05";
const MANUFACTURER = "Schneider Electric";

type Model = CatalogInput["models"][number];
type Terminal = NonNullable<Model["terminals"]>[number];

/** The Altivar 320 manuals (TASK-1012); the ATV320U07N4C record was read on 2026-10-12. */
const DRIVE_RETRIEVED = "2026-10-12";
const atv320Installation = {
  url: "https://download.schneider-electric.com/files?p_Doc_Ref=NVE41289",
  title: "Altivar Machine ATV320 Installation Manual",
  revision: "NVE41289.09, 04/2025",
  retrievedAt: DRIVE_RETRIEVED,
};
const atv320Programming = {
  url: "https://download.schneider-electric.com/files?p_Doc_Ref=NVE41295",
  title: "Altivar Machine ATV320 Programming Manual",
  revision: "NVE41295.06, 04/2025",
  retrievedAt: DRIVE_RETRIEVED,
};

/** A 24 V DC control terminal of the drive (installation manual, pages 174–175). */
const digital = (
  terminalLabel: string,
  direction: "INPUT" | "OUTPUT",
  notes: string,
  simulatorSignal?: string,
): Terminal => ({ terminalLabel, direction, ioType: "DIGITAL", signalType: "DC_24V", simulatorSignal, notes });

/** A fact read from the programming manual rather than the installation manual. */
const programming = (reference: string, note?: string) => ({ document: "programming", reference, note });

/**
 * Altivar Machine ATV320, 0.75 kW, 3-phase 380…500 V, compact (ATV320U07N4C). Electrical
 * data and terminals come from the installation manual; parameters, factory assignments,
 * functions and error codes from the programming manual. The drive is mapped onto the
 * generic VFD behaviour profile with its factory configuration ([Start/Stop] STS macro),
 * nothing reprogrammed; every value names its page.
 */
const atv320: Model = {
  manufacturer: MANUFACTURER,
  category: "VFD",
  family: "Altivar Machine ATV320",
  modelName: "ATV320U07N4C",
  sku: "ATV320U07N4C",
  runtimeSupport: "DEVICE_SIM",
  controlCapability: "PARAMETER_CONFIGURED",
  capabilities: ["PARAMETER_CONFIGURABLE"],
  verification: { status: "VERIFIED", source: atv320Installation, verifiedAt: DRIVE_RETRIEVED },
  documents: { programming: atv320Programming },
  // 3-phase supply voltage 380 (−15 %)…500 (+10 %) V AC, 50/60 Hz (installation manual, page 55).
  electrical: {
    supplyType: "AC",
    voltageMin: 380,
    voltageMax: 500,
    notes: "3-phase 380 (−15 %)…500 (+10 %) V AC, 50/60 Hz (installation manual, page 55).",
  },
  // The integrated RJ45 port is a Modbus serial line / CANopen port; Modbus TCP needs an
  // optional module and is not recorded (installation manual, pages 27, 178).
  ports: [
    {
      name: "RJ45",
      physicalType: "RJ45",
      notes: "Modbus serial line / CANopen; Modbus TCP only through an optional module, not recorded (pages 27, 178).",
    },
  ],
  terminals: [
    // Control block terminals (installation manual, pages 174–177) with the factory
    // assignments of the programming manual (page 16): DI1 forward, DI2 reverse, AI1 the
    // reference; DI3…DI6, AI2, AI3, LO1 (DQ), AQ1 and R2 unassigned.
    digital("DI1", "INPUT", "Digital input; factory [Forward] FRD = DI1 (programming manual, page 16).", "run"),
    digital(
      "DI2",
      "INPUT",
      "Digital input; factory [Reverse Assign] RRS = DI2 (programming manual, page 16).",
      "reverse",
    ),
    digital(
      "DI3",
      "INPUT",
      "Digital input; unassigned at factory (programming manual, page 16). Not a profile signal.",
    ),
    digital(
      "DI4",
      "INPUT",
      "Digital input; unassigned at factory (programming manual, page 16). Not a profile signal.",
    ),
    digital("DI5", "INPUT", "Digital input, also pulse input; unassigned at factory. Not a profile signal."),
    digital("DI6", "INPUT", "Digital input, also PTC input; unassigned at factory. Not a profile signal."),
    digital("STO", "INPUT", "Safe Torque Off input (page 175). Not modelled."),
    {
      terminalLabel: "AI1",
      direction: "INPUT",
      ioType: "ANALOG",
      signalType: "VOLTAGE_0_10V",
      simulatorSignal: "frequencySetpoint",
      notes: "0–10 V analog input; factory [Ref Freq 1 Config] FR1 = AI1 (programming manual, page 16).",
    },
    {
      terminalLabel: "AI2",
      direction: "INPUT",
      ioType: "ANALOG",
      signalType: "VOLTAGE_PM_10V",
      notes: "Bipolar ±10 V analog input; unassigned at factory. Not a profile signal.",
    },
    {
      terminalLabel: "AI3",
      direction: "INPUT",
      ioType: "ANALOG",
      signalType: "CURRENT_0_20MA",
      notes: "0–20 mA (or X–20 mA, 20–Y mA) analog input; unassigned at factory. Not a profile signal.",
    },
    {
      terminalLabel: "AQ1",
      direction: "OUTPUT",
      ioType: "ANALOG",
      signalType: "VOLTAGE_0_10V",
      notes: "Analog output, software-configurable 0–10 V or X–Y mA; unassigned at factory. Not a profile signal.",
    },
    digital(
      "R1A-R1C",
      "OUTPUT",
      "Relay R1 NO contact; factory [R1 Assignment] = [No drive flt], closed while no error is detected: the inverse of the profile's faulted, so it carries no signal (programming manual, page 16).",
    ),
    digital("R2A-R2C", "OUTPUT", "Relay R2 NO contact; unassigned at factory. Not a profile signal."),
    digital("DQ+", "OUTPUT", "Open-collector digital output DQ+/DQ− (LO1), 30 V DC 100 mA; unassigned at factory."),
    {
      terminalLabel: "+24",
      kind: "POWER",
      direction: "OUTPUT",
      signalType: "DC_24V",
      notes: "Digital input supply, 100 mA.",
    },
    {
      terminalLabel: "P24",
      kind: "POWER",
      direction: "INPUT",
      signalType: "DC_24V",
      notes: "External 24 V DC supply input for the digital inputs and STO, 1.1 A max.",
    },
    {
      terminalLabel: "COM",
      kind: "COMMON",
      maxConnections: 2,
      notes: "Analog I/O common, 0 V; two terminals (page 177).",
    },
    // Motor output (page 144) and the protective earth terminal.
    ...["U/T1", "V/T2", "W/T3"].map((terminalLabel): Terminal => ({
      terminalLabel,
      kind: "POWER",
      direction: "OUTPUT",
      signalType: "AC_400V",
    })),
    { terminalLabel: "PE", kind: "EARTH" },
  ],
  simulation: {
    coverage: "PARTIAL",
    profile: "VFD",
    profileVersion: 1,
    faults: ["OVERCURRENT", "OVERTEMPERATURE"],
    // Factory settings (programming manual, page 16): ACC and DEC 3.0 s, HSP 50.0 Hz.
    parameters: { maxFrequencyHz: 50, accelTimeS: 3, decelTimeS: 3 },
    features: driveFeatures([
      "LINEAR_RAMP",
      "REVERSAL",
      "TRIP_RESET",
      "S_RAMP",
      "DC_BRAKE",
      "CURRENT_LIMIT",
      "AUTO_RESTART",
      "FLYING_START",
      "PID",
    ]),
    sources: {
      "parameter:maxFrequencyHz": programming(
        "[High Speed] HSP, factory setting 50.0 Hz, 0 to 599 Hz, pages 16, 101",
        "HSP is the motor frequency at maximum reference, the profile's setpoint ceiling; the drive's [Max Frequency] tFr (60 Hz, page 100) is not modelled",
      ),
      "parameter:accelTimeS": programming(
        "[Acceleration] ACC, factory setting 3.0 s, 0.00 to 6,000 s, pages 16, 100",
        "the drive ramps from 0 to [Nominal Motor Freq] FrS; the profile ramps to maxFrequencyHz, equal to FrS at the factory settings (50 Hz, [Motor Standard] bFr = 50 IEC)",
      ),
      "parameter:decelTimeS": programming(
        "[Deceleration] DEC, factory setting 3.0 s, 0.00 to 6,000 s, pages 16, 101",
        "the drive ramps from [Nominal Motor Freq] FrS to 0; the profile from maxFrequencyHz",
      ),
      "fault:OVERCURRENT": programming("[Overcurrent] OCF, page 413"),
      "fault:OVERTEMPERATURE": programming("[Drive Overheating] OHF, page 413"),
      "feature:LINEAR_RAMP": programming(
        "[Acceleration] ACC and [Deceleration] DEC, pages 100–101; [Ramp Type] rPt factory setting [Linear] LIN, page 212",
      ),
      "feature:REVERSAL": programming("[Reverse Assign] RRS, factory setting DI2, page 16"),
      "feature:TRIP_RESET": programming("Error codes OCF and OHF, page 413; [Fault Reset Assign] RSF, page 327"),
      "feature:S_RAMP": programming("[Ramp Type] rPt: S-ramp, U-ramp, customized, page 212"),
      "feature:DC_BRAKE": programming("[Auto DC inj Level 1] SDC1, factory setting 0.7 In, page 109"),
      "feature:CURRENT_LIMIT": programming("[Current Limitation] CLI, factory setting 1.5 In, page 110"),
      "feature:AUTO_RESTART": programming("[Auto Fault Reset] ATR, factory setting [No] NO, page 329"),
      "feature:FLYING_START": programming("[Catch On Fly] FLR, factory setting [No] NO, page 332"),
      "feature:PID": programming("PID regulator function, page 260"),
    },
  },
  // Power and current ratings, 3-phase 380…500 V (installation manual, page 55).
  facts: {
    nominalPowerKw: 0.75,
    nominalPowerHp: 1.0,
    inputCurrentAt380VMaxA: 3.6,
    inputCurrentAt500VMaxA: 2.7,
    apparentPowerKva: 2.3,
    inrushCurrentMaxA: 10.0,
    outputCurrentRatedA: 2.3,
    transientCurrentMaxA: 3.5,
    frameSize: "1C",
  },
};

const hardwareGuide = {
  status: "VERIFIED",
  verifiedAt: RETRIEVED,
  source: {
    url: "https://download.schneider-electric.com/files?p_Doc_Ref=EIO0000003083",
    title: "Modicon M241 Logic Controller Hardware Guide",
    revision: "EIO0000003083.08, 04/2026",
    retrievedAt: RETRIEVED,
  },
} as const;

export const schneider: CatalogInput = {
  manufacturers: [{ name: MANUFACTURER, websiteUrl: "https://www.se.com" }],
  models: [
    {
      manufacturer: MANUFACTURER,
      category: "PLC",
      family: "Modicon M241",
      modelName: "TM241CE24T",
      sku: "TM241CE24T",
      architectureType: "COMPACT",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      capabilities: [...PLC_CAPABILITIES],
      simulation: PLC_SIMULATION,
      verification: hardwareGuide,
      // Rated voltage 24 V DC, power supply voltage range 20.4…28.8 V DC.
      electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8 },
      // 1 Ethernet port (function: Modbus TCP/IP, RJ45), 2 serial line ports, 1 USB mini-B programming port.
      ports: [
        { name: "Ethernet", physicalType: "RJ45", protocols: ["MODBUS_TCP"] },
        { name: "Serial line", physicalType: "Serial line", portCount: 2 },
        { name: "USB", physicalType: "USB mini-B", notes: "Programming port." },
      ],
      builtInChannels: [
        {
          // 14 digital inputs: 8 fast inputs (I0…I7) and 6 regular inputs (I8…I13); type 1 (IEC 61131-2).
          ioType: "DI",
          count: 14,
          signalType: "DC_24V",
          terminalLabels: Array.from({ length: 14 }, (_, index) => `I${index}`),
          limits: { inputType: "IEC 61131-2 type 1", fastInputs: 8, regularInputs: 6 },
        },
        {
          // 10 digital outputs, source transistor: 4 fast outputs (Q0…Q3) and 6 regular outputs.
          // Rated output voltage 24 V DC. Labels of the regular outputs were not checked.
          ioType: "DO",
          count: 10,
          signalType: "DC_24V",
          terminalLabels: ["Q0", "Q1", "Q2", "Q3"],
          limits: { outputType: "transistor, source", fastOutputs: 4, regularOutputs: 6 },
        },
      ],
      facts: { localExpansionModulesMax: 7 },
    },
    atv320,
  ],
};
