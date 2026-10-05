import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EXPORT_NOTICE, type PlcExportDocument, REPORT_SECTIONS } from "@/lib/export/plc-export";
import { PlcReport } from "./plc-report";

const compact: PlcExportDocument = {
  schema: "z-factory.plc-export",
  schemaVersion: 1,
  generatedAt: "2026-10-05T12:34:56.000Z",
  revision: {
    configuration: "3f2a9c1d0b7e",
    ioMapping: 4,
    modbusMapping: 7,
    program: {
      version: 2,
      language: "ST",
      checksum: "ab".repeat(32),
      status: "DEPLOYED",
      createdAt: "2026-10-05T10:00:00.000Z",
    },
    deployedSnapshot: { version: 3, createdAt: "2026-10-05T11:00:00.000Z" },
  },
  factory: { id: "f", name: "Pump House", slug: "pump-house", subnetCidr: "172.24.1.0/24" },
  plc: {
    id: "p",
    name: "PLC-01",
    role: "Pump station",
    architecture: "COMPACT",
    runtime: "OpenPLC",
    runtimeNote: "Runs on OpenPLC. The model is a hardware profile, not vendor firmware.",
    runtimeImage: "ghcr.io/autonomy-logic/openplc-runtime:v4.2.4",
    runtimeVersion: "v4.2.4",
  },
  model: {
    manufacturer: "Siemens",
    family: "SIMATIC S7-1200",
    modelName: "CPU 1214C DC/DC/DC",
    sku: "6ES7214-1AG40-0XB0",
    verificationStatus: "VERIFIED",
    source: {
      title: "SIMATIC S7-1200 Easy Book",
      revision: "A5E02486774-AG, 01/2015",
      url: "https://example.test/easy.pdf",
      verifiedAt: "2026-10-05",
    },
    facts: { workMemoryKb: 100 },
  },
  electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8 },
  ports: [{ name: "PROFINET", physicalType: "Ethernet 10/100 Mb/s", protocols: ["MODBUS_TCP"], portCount: 1 }],
  hardware: {
    channels: [
      { ioType: "DI", count: 14, occupied: 1 },
      { ioType: "DO", count: 10, occupied: 1 },
    ],
    rack: null,
  },
  ioPoints: [
    {
      source: "BUILT_IN",
      slot: null,
      module: null,
      ioType: "DI",
      channel: "Ia.0",
      vendorAddress: "%I0.0",
      programAddress: "%MX0.0",
      signalTypes: ["DC_24V"],
      status: "OCCUPIED",
      device: "XV-101",
      deviceTerminal: "ZSO",
      tag: "XV_101_ZSO",
    },
    {
      source: "BUILT_IN",
      slot: null,
      module: null,
      ioType: "DO",
      channel: "Qa.0",
      vendorAddress: null,
      programAddress: "%QX0.0",
      signalTypes: ["DC_24V"],
      status: "OCCUPIED",
      device: "XV-101",
      deviceTerminal: "Y1",
      tag: "XV_101_Y1",
    },
    {
      source: "BUILT_IN",
      slot: null,
      module: null,
      ioType: "DI",
      channel: "Ia.1",
      vendorAddress: "%I0.1",
      programAddress: "%MX0.1",
      signalTypes: ["DC_24V"],
      status: "FREE",
      device: null,
      deviceTerminal: null,
      tag: null,
    },
  ],
  tags: [
    {
      name: "XV_101_Y1",
      role: "STATUS",
      dataType: "BOOL",
      direction: "OUTPUT",
      programAddress: "%QX0.0",
      modbusArea: "COIL",
      modbusAddress: 0,
      modbusDisplayAddress: "00001",
      wordCount: 1,
      accessMode: "READ_ONLY",
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      scale: 1,
      offset: 0,
      unit: null,
      sourceDevice: "XV-101",
      sourceSignal: "open",
    },
    {
      name: "Pump01_StartCommand",
      role: "COMMAND",
      dataType: "BOOL",
      direction: "OUTPUT",
      programAddress: "%QX2.0",
      modbusArea: "COIL",
      modbusAddress: 16,
      modbusDisplayAddress: "00017",
      wordCount: 1,
      accessMode: "READ_WRITE",
      byteOrder: "BIG_ENDIAN",
      wordOrder: "HIGH_WORD_FIRST",
      scale: 1,
      offset: 0,
      unit: null,
      sourceDevice: null,
      sourceSignal: null,
    },
  ],
  connectedDevices: [
    {
      plcPoint: "DO Qa.0",
      tag: "XV_101_Y1",
      device: "XV-101 · Y1",
      model: "Generic on/off valve, 24 V DC",
      relationship: "CONTROLS",
      signalOrProtocol: "digital",
      address: "%QX0.0",
      unit: null,
    },
    {
      plcPoint: "—",
      tag: null,
      device: "VFD-02",
      model: "Generic VFD, Modbus TCP",
      relationship: "COMMUNICATES_WITH",
      signalOrProtocol: "Modbus TCP",
      address: null,
      unit: null,
    },
  ],
  relationships: [{ source: "PLC-01", relationship: "CONTROLS", target: "XV-101", detail: "1 wire" }],
  network: {
    serviceName: "plc-01",
    modbusEndpoint: { bindAddress: "127.0.0.1", hostPort: 15991, containerPort: 502 },
    modbusConventions: { addressBase: "zero-based", byteOrder: "BIG_ENDIAN", wordOrder: "HIGH_WORD_FIRST" },
    protocolLinks: [{ device: "VFD-02", protocol: "Modbus TCP" }],
  },
  topology: {
    nodes: [
      { id: "p", name: "PLC-01", kind: "PLC · compact", x: 0, y: 0 },
      { id: "v", name: "XV-101", kind: "Valve", x: 300, y: 100 },
    ],
    edges: [{ sourceId: "p", targetId: "v", relationship: "CONTROLS", label: "controls · 1 wire" }],
  },
  notice: EXPORT_NOTICE,
};

const section = (index: number) => screen.getByRole("region", { name: `${index} · ${REPORT_SECTIONS[index - 1]}` });

describe("PLC engineering report", () => {
  it("contains all 15 sections of the export specification, in order", () => {
    render(<PlcReport document={compact} />);
    const headings = screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent);
    expect(headings).toEqual(REPORT_SECTIONS.map((title, index) => `${index + 1} · ${title}`));
  });

  it("shows identity, model with its source, role, runtime, power and communication", () => {
    render(<PlcReport document={compact} />);
    expect(screen.getByRole("heading", { level: 2, name: "PLC-01 — Pump station" })).toBeInTheDocument();
    expect(within(section(1)).getByText("Pump House (pump-house)")).toBeInTheDocument();
    expect(within(section(2)).getByText("6ES7214-1AG40-0XB0")).toBeInTheDocument();
    expect(
      within(section(2)).getByText(/Source: SIMATIC S7-1200 Easy Book, A5E02486774-AG, 01\/2015; checked 2026-10-05/),
    ).toBeInTheDocument();
    expect(within(section(3)).getByText(/not vendor firmware/)).toBeInTheDocument();
    expect(within(section(4)).getByText("24 V DC (20.4–28.8 V)")).toBeInTheDocument();
    expect(within(section(4)).getByText("1 × Ethernet 10/100 Mb/s · Modbus TCP")).toBeInTheDocument();
    expect(within(section(4)).getByText("100 KB")).toBeInTheDocument();
  });

  it("lists occupied channels, tags, registers and the connected-device schedule", () => {
    render(<PlcReport document={compact} />);
    expect(within(section(5)).getByText("Compact PLC: built-in I/O, no rack.")).toBeInTheDocument();
    // Only channels in use are printed; the free one is counted.
    expect(within(section(6)).getAllByRole("row")).toHaveLength(3);
    expect(
      within(section(6)).getByText("2 of 3 channels in use. Free channels are listed in the I/O schedule (CSV)."),
    ).toBeInTheDocument();
    expect(within(section(6)).getByText("XV-101 · ZSO")).toBeInTheDocument();
    expect(within(section(7)).getByText("Pump01_StartCommand")).toBeInTheDocument();
    expect(within(section(8)).getByText("read/write")).toBeInTheDocument();
    expect(within(section(8)).getByText("00017")).toBeInTheDocument();

    const schedule = within(section(9));
    expect(schedule.getAllByRole("columnheader").map((header) => header.textContent)).toEqual([
      "PLC point",
      "Tag",
      "Device instance",
      "Model",
      "Relationship",
      "Signal / protocol",
      "Address",
      "Unit",
    ]);
    expect(schedule.getByText("communicates with")).toBeInTheDocument();
    expect(within(section(10)).getByText("1 wire")).toBeInTheDocument();
  });

  it("shows network configuration, versions, the diagram, and the revision with its time", () => {
    render(<PlcReport document={compact} />);
    expect(within(section(11)).getByText("127.0.0.1:15991 → port 502")).toBeInTheDocument();
    expect(within(section(11)).getByText("VFD-02 (Modbus TCP)")).toBeInTheDocument();
    expect(within(section(12)).getByText("v2 · ST · deployed · sha256 abababababab")).toBeInTheDocument();
    expect(within(section(12)).getByText("v3 · 2026-10-05 11:00 UTC")).toBeInTheDocument();
    expect(within(section(13)).getByText("Not requested for this export.")).toBeInTheDocument();
    expect(
      within(section(14)).getByRole("img", { name: "Topology of 2 devices and 1 connections" }),
    ).toBeInTheDocument();
    expect(within(section(15)).getByText("3f2a9c1d0b7e")).toBeInTheDocument();
    expect(within(section(15)).getByText("2026-10-05 12:34 UTC")).toBeInTheDocument();
    expect(screen.getByText(EXPORT_NOTICE)).toBeInTheDocument();
  });

  it("lays a modular PLC out by rack and slot, and prints the runtime state when requested", () => {
    render(
      <PlcReport
        document={{
          ...compact,
          plc: {
            ...compact.plc,
            name: "PLC-02",
            role: null,
            architecture: "MODULAR",
            runtimeImage: null,
            runtimeVersion: null,
          },
          hardware: {
            channels: [{ ioType: "DI", count: 16, occupied: 0 }],
            rack: {
              name: "S7-1500 mounting rail",
              slotCount: 31,
              modules: [
                {
                  slot: 4,
                  modelName: "DI 16x24VDC BA",
                  sku: "6ES7521-1BH10-0AA0",
                  moduleType: "DIGITAL_INPUT",
                  channels: 16,
                  occupied: 0,
                },
              ],
            },
          },
          ioPoints: [],
          tags: [],
          connectedDevices: [],
          relationships: [],
          revision: { ...compact.revision, program: null, deployedSnapshot: null },
          network: { ...compact.network, serviceName: null, modbusEndpoint: null, protocolLinks: [] },
          runtime: { state: "RUNNING", note: "Last state stored by Z-Factory, not a live reading." },
        }}
      />,
    );
    expect(screen.getByRole("heading", { level: 2, name: "PLC-02" })).toBeInTheDocument();
    expect(within(section(5)).getByText("S7-1500 mounting rail: 1 of 31 slots used.")).toBeInTheDocument();
    expect(within(section(5)).getByText("DI 16x24VDC BA")).toBeInTheDocument();
    expect(within(section(6)).getByText("No channel is in use.")).toBeInTheDocument();
    expect(within(section(9)).getByText("No device is connected.")).toBeInTheDocument();
    expect(within(section(11)).getByText("not configured (assigned when the PLC first starts)")).toBeInTheDocument();
    expect(within(section(12)).getByText("no program yet")).toBeInTheDocument();
    expect(within(section(12)).getByText("never deployed")).toBeInTheDocument();
    expect(within(section(13)).getByText("running")).toBeInTheDocument();
  });
});
