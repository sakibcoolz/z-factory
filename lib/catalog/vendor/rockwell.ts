/**
 * Rockwell Automation catalog records. Every value below was read from the Rockwell
 * publication named in the record's `source`. Values the publications do not state are
 * left out rather than filled in.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import { PLC_CAPABILITIES } from "@/lib/catalog/capabilities";

const RETRIEVED = "2026-10-05";
const MANUFACTURER = "Rockwell Automation";
const FAMILY = "CompactLogix 5380";

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
