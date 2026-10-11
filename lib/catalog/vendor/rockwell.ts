/**
 * Rockwell Automation catalog records. Every value below was read from the Rockwell
 * publication named in the record's `source`. Values the publications do not state are
 * left out rather than filled in.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import { driveFeatures, PLC_CAPABILITIES, PLC_SIMULATION } from "@/lib/catalog/capabilities";

const RETRIEVED = "2026-10-05";
const MANUFACTURER = "Rockwell Automation";
const FAMILY = "CompactLogix 5380";

type Model = CatalogInput["models"][number];
type Terminal = NonNullable<Model["terminals"]>[number];

/** The PowerFlex 520-series user manual (TASK-1012); the PowerFlex 525 record was read on 2026-10-12. */
const DRIVE_RETRIEVED = "2026-10-12";
const driveManual = {
  status: "VERIFIED",
  verifiedAt: DRIVE_RETRIEVED,
  source: {
    url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/um/520-um001_-en-e.pdf",
    title: "PowerFlex 520-series Adjustable Frequency AC Drive User Manual",
    revision: "520-UM001O-EN-E, September 2025",
    retrievedAt: DRIVE_RETRIEVED,
  },
} as const;

/** A 24 V DC control terminal of the drive's I/O block (page 42). */
const digital = (
  terminalLabel: string,
  direction: "INPUT" | "OUTPUT",
  notes: string,
  simulatorSignal?: string,
): Terminal => ({ terminalLabel, direction, ioType: "DIGITAL", signalType: "DC_24V", simulatorSignal, notes });

/**
 * PowerFlex 525, 480 V class, 5 HP / 4.0 kW normal duty (25B-D010N104). Every value is from
 * the user manual; the terminals are the control I/O block with its factory assignments
 * (t062…t068, t069, t072, t076, t081, t088, P047, P049), nothing reprogrammed. The
 * drive is mapped onto the generic VFD behaviour profile: the ramps, the reversal and the
 * trips are the profile's, and every value below names its page.
 */
const powerFlex525: Model = {
  manufacturer: MANUFACTURER,
  category: "VFD",
  family: "PowerFlex 525",
  modelName: "PowerFlex 525 25B-D010N104",
  sku: "25B-D010N104",
  runtimeSupport: "DEVICE_SIM",
  controlCapability: "PARAMETER_CONFIGURED",
  // Start source 1 and speed reference 1 default to the keypad and the drive's potentiometer (pages 88–89).
  capabilities: ["PARAMETER_CONFIGURABLE", "LOCAL_CONTROL"],
  verification: driveManual,
  // 380…480 V AC (−15 %, +10 %), 3-phase input; 0…460 V 3-phase output (pages 56, 169).
  electrical: {
    supplyType: "AC",
    voltageMin: 380,
    voltageMax: 480,
    notes: "380…480 V AC 3-phase, −15 % / +10 %; 0…460 V 3-phase output (pages 56, 169).",
  },
  // The embedded EtherNet/IP port and the RS-485 (DSI) port (pages 31, 102, 205). Neither
  // is claimed as Modbus TCP: the manual does not state it.
  ports: [
    { name: "Ethernet", physicalType: "Ethernet (RJ45)", notes: "Embedded EtherNet/IP adapter (page 102)." },
    { name: "DSI", physicalType: "RS-485 (RJ45)", notes: "DSI serial port (page 205)." },
  ],
  terminals: [
    // Control I/O terminal block (page 42) with the factory defaults of t062…t068 (page 90).
    digital("01", "INPUT", "Stop. Always a stop input; shipped jumpered to terminal 11 (page 42)."),
    digital(
      "02",
      "INPUT",
      "DigIn TermBlk 02; t062 default 48 2-Wire FWD (page 92). Start source 2 while 07 is on.",
      "run",
    ),
    digital("03", "INPUT", "DigIn TermBlk 03; t063 default 50 2-Wire REV (page 92).", "reverse"),
    { terminalLabel: "04", kind: "COMMON", notes: "Digital common (page 42)." },
    digital("05", "INPUT", "DigIn TermBlk 05; t065 default 7 Preset Freq (page 90). Not a profile signal."),
    digital("06", "INPUT", "DigIn TermBlk 06; t066 default 7 Preset Freq (page 90). Not a profile signal."),
    digital(
      "07",
      "INPUT",
      "DigIn TermBlk 07; t067 default 5 Spd + Strt 2: selects start source 2 (terminal block, P048) and speed reference 2 (0–10 V input, P049) while on (pages 88, 90).",
    ),
    digital("08", "INPUT", "DigIn TermBlk 08; t068 default 9 Jog Forward (page 90). Not a profile signal."),
    { terminalLabel: "11", kind: "POWER", direction: "OUTPUT", signalType: "DC_24V", notes: "+24 V DC (page 42)." },
    {
      terminalLabel: "13",
      direction: "INPUT",
      ioType: "ANALOG",
      signalType: "VOLTAGE_0_10V",
      simulatorSignal: "frequencySetpoint",
      notes: "0–10 V (or ±10 V) input; speed reference 2 default 5 0-10V Input (P049, page 88); 10 V = P044 (page 97).",
    },
    { terminalLabel: "14", kind: "COMMON", notes: "Analog common (page 42)." },
    {
      terminalLabel: "15",
      direction: "INPUT",
      ioType: "ANALOG",
      signalType: "CURRENT_4_20MA",
      notes: "4–20 mA input; speed reference option 6, not a factory default (page 88). Not a profile signal.",
    },
    {
      terminalLabel: "16",
      direction: "OUTPUT",
      ioType: "ANALOG",
      signalType: "VOLTAGE_0_10V",
      simulatorSignal: "actualFrequency",
      notes: "Analog output; t088 default 0 OutFreq 0-10: 0 V = 0 Hz, 10 V = P044 Maximum Freq (page 98).",
    },
    digital("17", "OUTPUT", "Opto output 1, 30 V DC 50 mA; t069 default 2 MotorRunning (pages 93–94).", "running"),
    digital("18", "OUTPUT", "Opto output 2, 30 V DC 50 mA; t072 default 1 At Frequency (pages 93–94).", "atSetpoint"),
    { terminalLabel: "19", kind: "COMMON", notes: "Opto common (page 42)." },
    digital(
      "R1-R2",
      "OUTPUT",
      "Relay 1 N.O. contact; t076 default 0 Ready/Fault, closed while the drive is ready: the inverse of the profile's faulted, so it carries no signal (page 96).",
    ),
    digital(
      "R5-R6",
      "OUTPUT",
      "Relay 2 N.C. contact; t081 default 2 MotorRunning, opens while the motor is powered: the inverse of the profile's running, so it carries no signal (page 96).",
    ),
    // Motor output (page 36) and the earth terminal.
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
    // OFFLINE is the generic fault every device has (TASK-1014), not a vendor fact.
    faults: ["OVERCURRENT", "OVERTEMPERATURE", "OFFLINE"],
    // Factory defaults of the Basic Program Group (pages 86–87).
    parameters: { maxFrequencyHz: 60, accelTimeS: 10, decelTimeS: 10 },
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
      "parameter:maxFrequencyHz": { reference: "P044 [Maximum Freq], default 60.00 Hz, 0.00/500.00 Hz, page 87" },
      "parameter:accelTimeS": {
        reference: "P041 [Accel Time 1], default 10.00 s, 0.00/600.00 s, page 86",
        note: "the time from 0 Hz to P044 [Maximum Freq], as the profile ramps",
      },
      "parameter:decelTimeS": { reference: "P042 [Decel Time 1], default 10.00 s, 0.00/600.00 s, page 86" },
      "fault:OVERCURRENT": {
        reference: "F012 HW OverCurrent, page 161",
        note: "the profile's one overcurrent trip; the drive also has F063 SW OverCurrent",
      },
      "fault:OVERTEMPERATURE": { reference: "F008 Heatsink OvrTmp, page 161" },
      "feature:LINEAR_RAMP": { reference: "P041 [Accel Time 1] and P042 [Decel Time 1], page 86" },
      "feature:REVERSAL": { reference: "t063 [DigIn TermBlk 03] default 50 2-Wire REV, page 92" },
      "feature:TRIP_RESET": {
        reference: "Fault codes F008 and F012, page 161; digital input option 13 Clear Fault, page 90",
      },
      "feature:S_RAMP": { reference: "A439 [S Curve %], page 119" },
      "feature:DC_BRAKE": { reference: "P045 [Stop Mode] options 2 and 3, page 87; A435 [DC Brake Level], page 118" },
      "feature:CURRENT_LIMIT": { reference: "A484 [Current Limit 1], page 125" },
      "feature:AUTO_RESTART": { reference: "A541 [Auto Rstrt Tries], page 134" },
      "feature:FLYING_START": { reference: "A545 [Flying Start En], page 134" },
      "feature:PID": { reference: "A459 [PID 1 Ref Sel], page 123" },
    },
  },
  // 380…480 V 3-phase rating table (page 26).
  facts: {
    normalDutyHp: 5.0,
    normalDutyKw: 4.0,
    heavyDutyHp: 5.0,
    heavyDutyKw: 4.0,
    outputCurrentA: 10.5,
    inputKva: 12.6,
    inputCurrentMaxA: 13.8,
    frameSize: "B",
  },
};

const controllerSpecs = {
  status: "VERIFIED",
  verifiedAt: RETRIEVED,
  source: {
    url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td002_-en-p.pdf",
    title: "CompactLogix 5380, Compact GuardLogix 5380, and CompactLogix 5480 Controllers Specifications",
    revision: "5069-TD002O-EN-P, November 2023",
    retrievedAt: RETRIEVED,
  },
} as const;

const ioSpecs = {
  status: "VERIFIED",
  verifiedAt: RETRIEVED,
  source: {
    url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/td/5069-td001_-en-p.pdf",
    title: "Compact 5000 I/O and Specialty Modules Specifications",
    revision: "5069-TD001P-EN-P, March 2026",
    retrievedAt: RETRIEVED,
  },
} as const;

const LOCAL_IO_NOTE = "Compact 5000 I/O module used as local I/O of the controller; slot rules are not recorded.";

export const rockwell: CatalogInput = {
  manufacturers: [{ name: MANUFACTURER, websiteUrl: "https://www.rockwellautomation.com" }],
  models: [
    {
      manufacturer: MANUFACTURER,
      category: "PLC",
      family: FAMILY,
      modelName: "5069-L306ER",
      sku: "5069-L306ER",
      architectureType: "MODULAR",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      capabilities: [...PLC_CAPABILITIES],
      simulation: PLC_SIMULATION,
      verification: controllerSpecs,
      // MOD power voltage range 18…32 V DC. The publication states no nominal value.
      electrical: { supplyType: "DC", voltageMin: 18, voltageMax: 32, notes: "MOD power; 450 mA max." },
      // Built-in ports: 2 Ethernet (10 Mbps, 100 Mbps, 1 Gbps), 1 USB 2.0 Type B. The publication
      // lists EtherNet/IP; it does not state Modbus TCP, so no protocol is claimed here.
      ports: [
        {
          name: "Ethernet",
          physicalType: "Ethernet 10/100/1000 Mbps",
          portCount: 2,
          notes: "EtherNet/IP; Dual-IP or Linear/DLR mode.",
        },
        {
          name: "USB",
          physicalType: "USB 2.0 Type B",
          notes: "Programming, configuration, firmware update and online edits only.",
        },
      ],
      facts: {
        userMemoryMb: 0.6,
        localIoModulesMax: 8,
        ethernetIpNodesMax: 16,
        socketInterfacesMax: 32,
        powerDissipationMaxW: 8.5,
      },
    },
    powerFlex525,
  ],
  racks: [
    {
      manufacturer: MANUFACTURER,
      family: FAMILY,
      name: "Local I/O, 8 modules",
      slotCount: 8,
      notes: "Local I/O modules, max. 8 for 5069-L306ER (5069-TD002).",
    },
  ],
  modules: [
    {
      manufacturer: MANUFACTURER,
      family: FAMILY,
      modelName: "5069-IB16",
      sku: "5069-IB16",
      moduleType: "DIGITAL_INPUT",
      verification: ioSpecs,
      // 16 channels (1 group of 16), sinking; 12/24 V DC sink; on-state 10…32 V DC, nominal 24 V DC.
      channels: [
        {
          ioType: "DI",
          count: 16,
          signalType: "DC_24V",
          limits: { inputType: "sinking", onStateMinV: 10, onStateMaxV: 32 },
        },
      ],
      compatibleCpus: ["5069-L306ER"],
      compatibilityNotes: LOCAL_IO_NOTE,
    },
    {
      manufacturer: MANUFACTURER,
      family: FAMILY,
      modelName: "5069-OB16",
      sku: "5069-OB16",
      moduleType: "DIGITAL_OUTPUT",
      verification: ioSpecs,
      // 16 channels (1 group of 16), sourcing; 12/24 V DC source; 0.5 A per channel.
      channels: [
        { ioType: "DO", count: 16, signalType: "DC_24V", limits: { outputType: "sourcing", currentPerChannelA: 0.5 } },
      ],
      compatibleCpus: ["5069-L306ER"],
      compatibilityNotes: LOCAL_IO_NOTE,
    },
    {
      manufacturer: MANUFACTURER,
      family: FAMILY,
      modelName: "5069-IF8",
      sku: "5069-IF8",
      moduleType: "ANALOG_INPUT",
      verification: ioSpecs,
      // Input ranges: ±10 V, 0…10 V, 0…5 V, 0…20 mA, 4…20 mA; 16 bits.
      channels: [
        {
          ioType: "AI",
          count: 8,
          signalType: "CURRENT_4_20MA",
          acceptedSignalTypes: ["CURRENT_0_20MA", "VOLTAGE_0_10V", "VOLTAGE_0_5V", "VOLTAGE_PM_10V"],
          limits: { resolutionBits: 16, wiring: "Series A: differential; Series B: single-ended" },
        },
      ],
      compatibleCpus: ["5069-L306ER"],
      compatibilityNotes: LOCAL_IO_NOTE,
    },
    {
      manufacturer: MANUFACTURER,
      family: FAMILY,
      modelName: "5069-OF4",
      sku: "5069-OF4",
      moduleType: "ANALOG_OUTPUT",
      verification: ioSpecs,
      // Output ranges: ±10 V, 0…10 V, 0…5 V, 0…20 mA, 4…20 mA; 16 bits.
      channels: [
        {
          ioType: "AO",
          count: 4,
          signalType: "VOLTAGE_0_10V",
          acceptedSignalTypes: ["VOLTAGE_PM_10V", "VOLTAGE_0_5V", "CURRENT_0_20MA", "CURRENT_4_20MA"],
          limits: { resolutionBits: 16 },
        },
      ],
      compatibleCpus: ["5069-L306ER"],
      compatibilityNotes: LOCAL_IO_NOTE,
    },
  ],
};
