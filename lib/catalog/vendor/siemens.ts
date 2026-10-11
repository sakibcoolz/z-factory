/**
 * Siemens catalog records. Every value below was read from the Siemens document named in
 * the record's `source` (docs/references/catalog-sources.md lists them). Values the
 * documents do not state are left out rather than filled in.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import { PLC_CAPABILITIES, PLC_SIMULATION } from "@/lib/catalog/capabilities";

const RETRIEVED = "2026-10-05";
const MANUFACTURER = "Siemens";
const S7_1500 = "SIMATIC S7-1500";

const easyBook = {
  url: "https://cache.industry.siemens.com/dl/files/145/39710145/att_5787/v1/s71200_easy_book_en-US_en-US.pdf",
  title: "SIMATIC S7-1200 Easy Book",
  revision: "A5E02486774-AG, 01/2015",
  retrievedAt: RETRIEVED,
};

const cpu1511Manual = {
  url: "https://cache.industry.siemens.com/dl/files/841/109752841/att_936124/v4/s71500_cpu1511_1_pn_dtc_manual_en-US_en-US.pdf",
  title: "SIMATIC S7-1500 CPU 1511-1 PN (6ES7511-1AK02-0AB0) Equipment Manual",
  revision: "A5E40869673-AB, 05/2021",
  retrievedAt: RETRIEVED,
};

const verified = (source: typeof easyBook) => ({ status: "VERIFIED", source, verifiedAt: RETRIEVED }) as const;

const moduleManual = (path: string, title: string, revision: string) =>
  verified({ url: `https://cache.industry.siemens.com/dl/files/${path}`, title, revision, retrievedAt: RETRIEVED });

const S7_1500_NOTE = "S7-1500 / ET 200MP module per its manual; slot rules are not recorded.";

export const siemens: CatalogInput = {
  manufacturers: [{ name: MANUFACTURER, websiteUrl: "https://www.siemens.com" }],
  models: [
    {
      manufacturer: MANUFACTURER,
      category: "PLC",
      family: "SIMATIC S7-1200",
      modelName: "CPU 1214C DC/DC/DC",
      sku: "6ES7214-1AG40-0XB0",
      architectureType: "COMPACT",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      capabilities: [...PLC_CAPABILITIES],
      simulation: PLC_SIMULATION,
      verification: verified(easyBook),
      // Table A-8: rated voltage 24 V DC, tolerance 20.4 to 28.8 V DC.
      electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8 },
      // Table A-12: one Ethernet port, 10/100 Mb/s. Modbus TCP: MB_CLIENT / MB_SERVER over PROFINET.
      ports: [{ name: "PROFINET", physicalType: "Ethernet 10/100 Mb/s", protocols: ["MODBUS_TCP"] }],
      builtInChannels: [
        {
          // Table A-26: IEC type 1, sink/source, 24 V DC at 4 mA nominal. Inputs Ia.0–Ib.5, I0.0–I1.5.
          ioType: "DI",
          count: 14,
          signalType: "DC_24V",
          terminalLabels: [0, 1, 2, 3, 4, 5, 6, 7]
            .map((bit) => `Ia.${bit}`)
            .concat([0, 1, 2, 3, 4, 5].map((bit) => `Ib.${bit}`)),
          addressHints: [0, 1, 2, 3, 4, 5, 6, 7]
            .map((bit) => `%I0.${bit}`)
            .concat([0, 1, 2, 3, 4, 5].map((bit) => `%I1.${bit}`)),
          limits: { inputType: "IEC type 1, sink/source", ratedCurrentMa: 4, logic1MinV: 15, logic0MaxV: 5 },
        },
        {
          // Table A-29: solid-state MOSFET, sourcing, 20.4 to 28.8 V DC, 0.5 A max. Outputs Qa.0–Qb.1.
          ioType: "DO",
          count: 10,
          signalType: "DC_24V",
          terminalLabels: [0, 1, 2, 3, 4, 5, 6, 7].map((bit) => `Qa.${bit}`).concat(["Qb.0", "Qb.1"]),
          limits: { outputType: "MOSFET, sourcing", currentMaxA: 0.5 },
        },
        {
          // Table A-37: voltage, single-ended, 0 to 10 V, 10 bits, full scale 0 to 27648.
          ioType: "AI",
          count: 2,
          signalType: "VOLTAGE_0_10V",
          limits: { resolutionBits: 10, fullScale: 27648 },
        },
      ],
      facts: {
        workMemoryKb: 100,
        loadMemoryMb: 4,
        retentiveMemoryKb: 10,
        powerDissipationW: 12,
        signalModulesMax: 8,
        signalBoardsMax: 1,
        communicationModulesMax: 3,
      },
    },
    {
      manufacturer: MANUFACTURER,
      category: "PLC",
      family: S7_1500,
      modelName: "CPU 1511-1 PN",
      sku: "6ES7511-1AK02-0AB0",
      architectureType: "MODULAR",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      capabilities: [...PLC_CAPABILITIES],
      simulation: PLC_SIMULATION,
      verification: verified(cpu1511Manual),
      // Supply voltage 24 V DC, permissible range 19.2 to 28.8 V.
      electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 19.2, voltageMax: 28.8 },
      // One PROFINET interface (X1) with two RJ45 ports and an integrated switch. MODBUS: yes, MODBUS TCP.
      ports: [
        {
          name: "PROFINET X1",
          physicalType: "RJ45 (Ethernet)",
          protocols: ["MODBUS_TCP"],
          portCount: 2,
          notes: "One interface, two ports, integrated switch.",
        },
      ],
      facts: {
        workMemoryProgramKb: 150,
        workMemoryDataMb: 1,
        powerLossTypW: 5.7,
        modulesPerRackMax: 32,
      },
    },
  ],
  racks: [
    {
      manufacturer: MANUFACTURER,
      family: S7_1500,
      name: "S7-1500 mounting rail",
      // Slots hold the modules next to the CPU; the CPU itself takes none of them.
      slotCount: 31,
      notes: "Modules per rack, max. 32: CPU + 31 modules (CPU 1511-1 PN equipment manual).",
    },
  ],
  modules: [
    {
      manufacturer: MANUFACTURER,
      family: S7_1500,
      modelName: "DI 16x24VDC BA",
      sku: "6ES7521-1BH10-0AA0",
      moduleType: "DIGITAL_INPUT",
      verification: moduleManual(
        "190/83501190/att_905051/v1/s71500_di_16x24vdc_ba_manual_en-US_en-US.pdf",
        "S7-1500 / ET 200MP Digital input module DI 16x24VDC BA (6ES7521-1BH10-0AA0) Manual",
        "A5E32363114-AD, 12/2016",
      ),
      channels: [{ ioType: "DI", count: 16, signalType: "DC_24V", limits: { inputType: "sinking" } }],
      compatibleCpus: ["CPU 1511-1 PN"],
      compatibilityNotes: S7_1500_NOTE,
      facts: { supplyRatedV: 24, supplyMinV: 20.4, supplyMaxV: 28.8, powerLossTypW: 1.8 },
    },
    {
      manufacturer: MANUFACTURER,
      family: S7_1500,
      modelName: "DQ 16x24VDC/0.5A BA",
      sku: "6ES7522-1BH10-0AA0",
      moduleType: "DIGITAL_OUTPUT",
      verification: moduleManual(
        "415/83500415/att_902638/v1/s71500_dq_16x24vdc_0_5a_ba_manual_en-US_en-US.pdf",
        "S7-1500 / ET 200MP Digital output module DQ 16x24VDC/0.5A BA (6ES7522-1BH10-0AA0) Manual",
        "A5E32364017-AC, 09/2016",
      ),
      channels: [{ ioType: "DO", count: 16, signalType: "DC_24V", limits: { outputType: "sourcing" } }],
      compatibleCpus: ["CPU 1511-1 PN"],
      compatibilityNotes: S7_1500_NOTE,
      facts: { supplyRatedV: 24, supplyMinV: 20.4, supplyMaxV: 28.8, powerLossTypW: 2.2 },
    },
    {
      manufacturer: MANUFACTURER,
      family: S7_1500,
      modelName: "AI 8xU/I/RTD/TC ST",
      sku: "6ES7531-7KF00-0AB0",
      moduleType: "ANALOG_INPUT",
      verification: moduleManual(
        "205/59193205/att_902256/v1/s71500_ai_8xu_i_rtd_tc_st_manual_en-US_en-US.pdf",
        "S7-1500 / ET 200MP Analog input module AI 8xU/I/RTD/TC ST (6ES7531-7KF00-0AB0) Manual",
        "A5E03484864-AE, 08/2018",
      ),
      channels: [
        {
          // The manual lists 0 to +10 V and 0 to +5 V as not available on this module.
          ioType: "AI",
          count: 8,
          signalType: "CURRENT_4_20MA",
          acceptedSignalTypes: ["CURRENT_0_20MA", "CURRENT_PM_20MA", "VOLTAGE_PM_10V", "VOLTAGE_1_5V"],
          limits: {
            resolutionBits: 16,
            otherRanges: ["±5 V", "±2.5 V", "±1 V", "±500 mV", "±250 mV", "±80 mV", "±50 mV"],
          },
        },
      ],
      compatibleCpus: ["CPU 1511-1 PN"],
      compatibilityNotes: S7_1500_NOTE,
      facts: { supplyRatedV: 24, powerLossTypW: 2.7 },
    },
    {
      manufacturer: MANUFACTURER,
      family: S7_1500,
      modelName: "AQ 4xU/I ST",
      sku: "6ES7532-5HD00-0AB0",
      moduleType: "ANALOG_OUTPUT",
      verification: moduleManual(
        "850/59191850/att_903132/v1/s71500_aq_4xu_i_st_manual_en-US_en-US.pdf",
        "S7-1500 / ET 200MP Analog output module AQ 4xU/I ST (6ES7532-5HD00-0AB0) Manual",
        "A5E03484696-AE, 08/2018",
      ),
      channels: [
        {
          ioType: "AO",
          count: 4,
          signalType: "VOLTAGE_0_10V",
          acceptedSignalTypes: [
            "VOLTAGE_PM_10V",
            "VOLTAGE_1_5V",
            "CURRENT_4_20MA",
            "CURRENT_0_20MA",
            "CURRENT_PM_20MA",
          ],
          limits: { resolutionBits: 16 },
        },
      ],
      compatibleCpus: ["CPU 1511-1 PN"],
      compatibilityNotes: S7_1500_NOTE,
      facts: { supplyRatedV: 24, powerLossTypW: 4 },
    },
  ],
};
