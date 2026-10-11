/**
 * Schneider Electric catalog records. Every value below was read from the Schneider
 * document named in the record's `source`. Values the document does not state, or that
 * were not checked, are left out rather than filled in.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import { PLC_CAPABILITIES, PLC_SIMULATION } from "@/lib/catalog/capabilities";

const RETRIEVED = "2026-10-05";
const MANUFACTURER = "Schneider Electric";

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
  ],
};
