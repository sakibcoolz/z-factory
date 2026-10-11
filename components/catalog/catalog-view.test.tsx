import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatFact, signalTypeLabel } from "@/lib/catalog/format";
import {
  assetSummaryLabel,
  type CatalogAssetVersion,
  type CatalogModelDetail,
  type PeripheralCompatibility,
  summarizeAssetVersions,
} from "@/lib/domain/catalog-view";
import { CatalogModelView } from "./catalog-view";

const notSimulated: CatalogModelDetail["simulation"] = {
  coverage: "NOT_SIMULATABLE",
  profile: null,
  reason: "A programmable controller: its program runs on the OpenPLC adapter.",
  faults: [],
  parameters: {},
  features: [],
  sources: {},
  protocol: null,
  runtimeOnly: null,
  statement: "configuration and metadata only; the simulator executes no behaviour for it",
};

const plc: CatalogModelDetail = {
  id: "0199a000-0000-7000-8000-000000000001",
  modelName: "CPU 1214C DC/DC/DC",
  sku: "6ES7214-1AG40-0XB0",
  architectureType: "COMPACT",
  verificationStatus: "VERIFIED",
  manufacturer: "Siemens",
  family: "SIMATIC S7-1200",
  categoryCode: "PLC",
  categoryName: "PLC / programmable controller",
  runtimeSupport: "OPENPLC",
  controlCapability: "PROGRAMMABLE",
  lifecycleStatus: "UNKNOWN",
  simulation: notSimulated,
  registers: [],
  source: {
    url: "https://cache.industry.siemens.com/dl/files/145/39710145/att_5787/v1/s71200_easy_book_en-US_en-US.pdf",
    title: "SIMATIC S7-1200 Easy Book",
    revision: "A5E02486774-AG, 01/2015",
    retrievedAt: "2026-10-05",
    verifiedAt: "2026-10-05",
  },
  electrical: { supplyType: "DC", nominalVoltage: 24, voltageMin: 20.4, voltageMax: 28.8, notes: null },
  ports: [
    { name: "PROFINET", physicalType: "Ethernet 10/100 Mb/s", protocols: ["MODBUS_TCP"], portCount: 1, notes: null },
  ],
  builtInChannels: [
    { ioType: "DI", count: 14, signalType: "DC_24V", acceptedSignalTypes: [] },
    { ioType: "AI", count: 2, signalType: "VOLTAGE_0_10V", acceptedSignalTypes: [] },
  ],
  terminals: [],
  facts: { workMemoryKb: 100, signalModulesMax: 8 },
  racks: [],
  modules: [],
  asset: { state: "NONE", activeVersion: null },
  assetVersions: [],
  placeholderKind: "cabinet",
};

const assetVersion = (overrides: Partial<CatalogAssetVersion>): CatalogAssetVersion => ({
  id: `0199a000-0000-7000-8000-0000000000a${overrides.version ?? 1}`,
  version: 1,
  status: "READY",
  active: false,
  provider: "MESHY",
  providerJobId: null,
  providerStatus: null,
  statusMessage: null,
  sizeBytes: null,
  updatedAt: "2026-10-05",
  ...overrides,
});

const peripheral = (overrides: Partial<PeripheralCompatibility>): PeripheralCompatibility => ({
  modelId: "0199a000-0000-7000-8000-000000000002",
  manufacturer: "Generic / simulated",
  modelName: "Generic pressure transmitter, 0–10 V",
  categoryCode: "SENSOR",
  categoryName: "Sensor / transmitter",
  verificationStatus: "GENERIC",
  controlCapability: "DIRECT_IO",
  directIo: {
    compatible: true,
    terminals: [{ terminalLabel: "OUT", required: "AI", signalType: "VOLTAGE_0_10V", satisfied: true, modules: [] }],
  },
  protocols: [],
  compatible: true,
  ...overrides,
});

describe("catalog fact formatting", () => {
  it("turns fact keys into labels with units and qualifiers", () => {
    expect(formatFact("workMemoryKb", 100)).toEqual(["Work memory", "100 KB"]);
    expect(formatFact("loadMemoryMb", 4)).toEqual(["Load memory", "4 MB"]);
    expect(formatFact("powerLossTypW", 5.7)).toEqual(["Power loss, typ.", "5.7 W"]);
    expect(formatFact("signalModulesMax", 8)).toEqual(["Signal modules, max.", "8"]);
    expect(formatFact("supplyRatedV", 24)).toEqual(["Supply, rated", "24 V"]);
    expect(formatFact("otherRanges", ["±5 V", "±1 V"])).toEqual(["Other ranges", "±5 V, ±1 V"]);
  });

  it("labels known signal types and passes unknown ones through", () => {
    expect(signalTypeLabel("CURRENT_4_20MA")).toBe("4–20 mA");
    expect(signalTypeLabel("SOMETHING_ELSE")).toBe("SOMETHING_ELSE");
  });
});

describe("catalog model view", () => {
  it("shows a verified PLC with its order number, facts and linked source", () => {
    render(<CatalogModelView model={plc} peripherals={[]} />);

    expect(screen.getByRole("heading", { name: "CPU 1214C DC/DC/DC" })).toBeInTheDocument();
    expect(screen.getByText("6ES7214-1AG40-0XB0")).toBeInTheDocument();
    expect(screen.getByText("Siemens · SIMATIC S7-1200 · compact")).toBeInTheDocument();
    expect(screen.getByText("verified 2026-10-05")).toBeInTheDocument();
    expect(screen.getByText("24 V DC (20.4–28.8 V)")).toBeInTheDocument();
    expect(screen.getByText("PROFINET ×1 · Ethernet 10/100 Mb/s · Modbus TCP")).toBeInTheDocument();
    expect(screen.getByText("14 × DI · 24 V DC")).toBeInTheDocument();
    expect(screen.getByText("2 × AI · 0–10 V")).toBeInTheDocument();
    expect(screen.getByText("100 KB")).toBeInTheDocument();
    expect(screen.getByText("OpenPLC (no vendor firmware)")).toBeInTheDocument();

    const source = screen.getByRole("link", { name: "SIMATIC S7-1200 Easy Book" });
    expect(source).toHaveAttribute("href", plc.source.url);
    expect(screen.getByText(/A5E02486774-AG, 01\/2015 · retrieved 2026-10-05/)).toBeInTheDocument();
  });

  it("lists peripherals with what they need and whether they fit", () => {
    render(
      <CatalogModelView
        model={plc}
        peripherals={[
          peripheral({}),
          peripheral({
            modelId: "0199a000-0000-7000-8000-000000000003",
            modelName: "Generic pressure transmitter, 4–20 mA",
            compatible: false,
            directIo: {
              compatible: false,
              terminals: [
                { terminalLabel: "OUT", required: "AI", signalType: "CURRENT_4_20MA", satisfied: false, modules: [] },
              ],
            },
          }),
          peripheral({
            modelId: "0199a000-0000-7000-8000-000000000004",
            modelName: "Generic VFD, Modbus TCP",
            categoryName: "Variable-frequency drive",
            directIo: null,
            protocols: ["MODBUS_TCP"],
          }),
        ]}
      />,
    );
    const rows = screen.getAllByRole("row").slice(1);
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText("1 × AI 0–10 V")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByText("built-in I/O")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("no")).toBeInTheDocument();
    expect(within(rows[1] as HTMLElement).getByText("no AI 4–20 mA")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("Modbus TCP")).toBeInTheDocument();
    expect(within(rows[2] as HTMLElement).getByText("over the network")).toBeInTheDocument();
    expect(within(rows[0] as HTMLElement).getByRole("link")).toHaveAttribute(
      "href",
      "/catalog?model=0199a000-0000-7000-8000-000000000002",
    );
  });

  it("shows a modular PLC's modules and a generic model without any vendor claim", () => {
    const { unmount } = render(
      <CatalogModelView
        model={{
          ...plc,
          modelName: "CPU 1511-1 PN",
          architectureType: "MODULAR",
          builtInChannels: [],
          racks: [{ name: "S7-1500 mounting rail", slotCount: 31, notes: null }],
          modules: [
            {
              modelName: "AI 8xU/I/RTD/TC ST",
              sku: "6ES7531-7KF00-0AB0",
              moduleType: "ANALOG_INPUT",
              verificationStatus: "VERIFIED",
              channels: [
                { ioType: "AI", count: 8, signalType: "CURRENT_4_20MA", acceptedSignalTypes: ["VOLTAGE_PM_10V"] },
              ],
              notes: null,
            },
          ],
        }}
        peripherals={[]}
      />,
    );
    expect(screen.getByText("through modules")).toBeInTheDocument();
    expect(screen.getByText("Installable modules · S7-1500 mounting rail, 31 slots")).toBeInTheDocument();
    expect(screen.getByText("8 × AI · 4–20 mA / ±10 V")).toBeInTheDocument();
    unmount();

    render(
      <CatalogModelView
        model={{
          ...plc,
          modelName: "Generic on/off valve, 24 V DC",
          sku: null,
          architectureType: null,
          manufacturer: "Generic / simulated",
          family: "Generic valves",
          categoryCode: "VALVE",
          categoryName: "Valve",
          verificationStatus: "GENERIC",
          runtimeSupport: "DEVICE_SIM",
          controlCapability: "DIRECT_IO",
          simulation: {
            coverage: "GENERIC",
            profile: { key: "VALVE", version: 1 },
            reason: null,
            faults: ["STUCK"],
            parameters: {},
            features: [],
            sources: {},
            protocol: null,
            runtimeOnly: null,
            statement:
              "the generic behaviour of its category (behaviour profile VALVE v1): a behaviour model, not vendor firmware",
          },
          source: { url: null, title: null, revision: null, retrievedAt: null, verifiedAt: null },
          electrical: null,
          ports: [],
          builtInChannels: [],
          terminals: [
            {
              terminalLabel: "Y1",
              kind: "SIGNAL",
              maxConnections: 1,
              direction: "INPUT",
              ioType: "DIGITAL",
              signalType: "DC_24V",
              simulatorSignal: "open",
            },
          ],
          facts: {},
        }}
      />,
    );
    expect(screen.getByText("generic · simulated")).toBeInTheDocument();
    expect(screen.getByText("Y1 · in · 24 V DC")).toBeInTheDocument();
    expect(screen.getByText("direct PLC I/O")).toBeInTheDocument();
    expect(screen.getByText(/makes no claim about any vendor/)).toBeInTheDocument();
    expect(screen.getByText("simulation · generic")).toBeInTheDocument();
    expect(
      screen.getByText(/behaviour profile VALVE v1\): a behaviour model, not vendor firmware\./),
    ).toBeInTheDocument();
    expect(screen.getByText("STUCK")).toBeInTheDocument();
    expect(screen.getByText("the profile's generic defaults")).toBeInTheDocument();
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });

  it("names the manufacturer document behind every model-specific value of a vendor drive (TASK-1012)", () => {
    render(
      <CatalogModelView
        model={{
          ...plc,
          modelName: "PowerFlex 525 25B-D010N104",
          sku: "25B-D010N104",
          architectureType: null,
          manufacturer: "Rockwell Automation",
          family: "PowerFlex 525",
          categoryCode: "VFD",
          categoryName: "Variable-frequency drive",
          runtimeSupport: "DEVICE_SIM",
          controlCapability: "PARAMETER_CONFIGURED",
          source: {
            url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/um/520-um001_-en-e.pdf",
            title: "PowerFlex 520-series User Manual",
            revision: "520-UM001O-EN-E, September 2025",
            retrievedAt: "2026-10-12",
            verifiedAt: "2026-10-12",
          },
          simulation: {
            coverage: "PARTIAL",
            profile: { key: "VFD", version: 1 },
            reason: null,
            faults: ["OVERCURRENT"],
            parameters: { maxFrequencyHz: 60 },
            features: [{ key: "S_RAMP", label: "S-ramp", implemented: false }],
            sources: {
              "parameter:maxFrequencyHz": {
                reference: "P044 [Maximum Freq], default 60.00 Hz, page 87",
                note: null,
                document: {
                  url: "https://literature.rockwellautomation.com/idc/groups/literature/documents/um/520-um001_-en-e.pdf",
                  title: "PowerFlex 520-series User Manual",
                  revision: "520-UM001O-EN-E, September 2025",
                  retrievedAt: "2026-10-12",
                },
              },
              "fault:OVERCURRENT": {
                reference: "F012 HW OverCurrent, page 161",
                note: "the profile's one overcurrent trip",
                document: null,
              },
              "feature:S_RAMP": { reference: "A439 [S Curve %], page 119", note: null, document: null },
            },
            protocol: null,
            runtimeOnly: null,
            statement:
              "a declared subset of this model's behaviour is implemented (behaviour profile VFD v1): a behaviour model, not vendor firmware",
          },
          electrical: null,
          ports: [],
          builtInChannels: [],
          terminals: [],
          facts: {},
        }}
      />,
    );
    expect(screen.getByText("simulation · partial")).toBeInTheDocument();
    expect(screen.getByText(/P044 \[Maximum Freq\], default 60.00 Hz, page 87/)).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "PowerFlex 520-series User Manual" }).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/F012 HW OverCurrent, page 161 — the profile's one overcurrent trip/)).toBeInTheDocument();
    expect(screen.getByText(/A439 \[S Curve %\], page 119/)).toBeInTheDocument();
  });

  it("shows the declared register map of a protocol-controlled model (TASK-1013)", () => {
    render(
      <CatalogModelView
        model={{
          ...plc,
          modelName: "Generic VFD, Modbus TCP",
          sku: null,
          architectureType: null,
          manufacturer: "Generic / simulated",
          family: "Generic drives",
          categoryCode: "VFD",
          categoryName: "Variable-frequency drive",
          verificationStatus: "GENERIC",
          runtimeSupport: "NONE",
          controlCapability: "PROTOCOL_CONTROLLED",
          source: { url: null, title: null, revision: null, retrievedAt: null, verifiedAt: null },
          simulation: {
            ...notSimulated,
            reason: "The runtime runs profile VFD and serves its registers over Modbus TCP.",
            protocol: { kind: "MODBUS_TCP", registerMap: { key: "VFD_MODBUS_TCP", version: 1 } },
            runtimeOnly: { profile: { key: "VFD", version: 1 } },
          },
          ports: [{ name: "Ethernet", physicalType: "Ethernet", protocols: ["MODBUS_TCP"], portCount: 1, notes: null }],
          registers: [
            {
              protocol: "MODBUS_TCP",
              area: "COIL",
              address: 0,
              dataType: "BOOL",
              wordCount: 1,
              access: "READ_WRITE",
              scale: 1,
              unit: null,
              semanticRole: "COMMAND",
            },
            {
              protocol: "MODBUS_TCP",
              area: "HOLDING_REGISTER",
              address: 0,
              dataType: "UINT16",
              wordCount: 1,
              access: "READ_WRITE",
              scale: 0.1,
              unit: "Hz",
              semanticRole: "SETPOINT",
            },
            {
              protocol: "MODBUS_TCP",
              area: "INPUT_REGISTER",
              address: 0,
              dataType: "UINT16",
              wordCount: 1,
              access: "READ_ONLY",
              scale: 0.1,
              unit: "Hz",
              semanticRole: "FEEDBACK",
            },
          ],
        }}
      />,
    );
    expect(screen.getByText(/declared register map VFD_MODBUS_TCP v1/)).toBeInTheDocument();
    const table = screen.getByRole("table");
    expect(within(table).getAllByRole("row")).toHaveLength(4);
    expect(within(table).getByText("holding register")).toBeInTheDocument();
    expect(within(table).getAllByText("read / write")).toHaveLength(2);
    expect(within(table).getByText("setpoint")).toBeInTheDocument();
    expect(screen.getByText(/never guessed/)).toBeInTheDocument();
  });

  it("says a programmable controller is not a simulated device, and why", () => {
    render(<CatalogModelView model={plc} peripherals={[]} />);
    expect(screen.getByText("simulation · not simulated")).toBeInTheDocument();
    expect(screen.getByText(/executes no behaviour for it\. A programmable controller/)).toBeInTheDocument();
    expect(screen.queryByText("Declared features")).not.toBeInTheDocument();
  });
});

describe("3D asset status in the catalog", () => {
  it("says a model without an asset is drawn as its category's generic shape", () => {
    render(<CatalogModelView model={plc} peripherals={[]} />);
    expect(screen.getByText("generic shape")).toBeInTheDocument();
    expect(screen.getByText(/Drawn in the 3D view as the generic cabinet shape of its category\./)).toBeInTheDocument();
    // Generation is authoring work: the screen names the command and offers no control for it.
    expect(screen.getByText("npm run assets")).toBeInTheDocument();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("columnheader", { name: "Version" })).not.toBeInTheDocument();
  });

  it("lists the versions with their state, source and what the provider said", () => {
    const assetVersions = [
      assetVersion({
        version: 4,
        status: "PENDING",
        providerJobId: "018a-mesh",
        providerStatus: "mesh in progress 40%",
      }),
      assetVersion({
        version: 3,
        status: "FAILED",
        providerJobId: "018a-old",
        statusMessage: "The provider failed the mesh: refused.",
      }),
      assetVersion({ version: 2, status: "READY", active: true, sizeBytes: 4_260_000 }),
      assetVersion({ version: 1, status: "RETIRED", provider: "MANUAL", statusMessage: "Looked like a product." }),
    ];
    render(
      <CatalogModelView
        model={{ ...plc, asset: summarizeAssetVersions(assetVersions), assetVersions }}
        peripherals={[]}
      />,
    );

    expect(screen.getByText("3D v2 · generating")).toBeInTheDocument();
    expect(screen.getByText(/Every factory instance is drawn from version 2\./)).toBeInTheDocument();
    const rows = screen.getAllByRole("row").filter((row) => /^v\d/.test(row.textContent ?? ""));
    expect(
      rows.map((row) =>
        within(row)
          .getAllByRole("cell")
          .map((cell) => cell.textContent),
      ),
    ).toEqual([
      ["v4", "pending", "meshy018a-mesh", "2026-10-05", "mesh in progress 40%"],
      ["v3", "failed", "meshy018a-old", "2026-10-05", "The provider failed the mesh: refused."],
      ["v2", "ready · rendered", "meshy", "2026-10-05", "4.3 MB"],
      ["v1", "retired", "manual", "2026-10-05", "Looked like a product."],
    ]);
    expect(rows[3]).toHaveAttribute("data-muted", "true");
  });

  it("works out one state per model from its versions", () => {
    const state = (...versions: Array<Partial<CatalogAssetVersion>>) => {
      const summary = summarizeAssetVersions(versions.map(assetVersion));
      return [summary.state, summary.activeVersion, assetSummaryLabel(summary)];
    };
    expect(state()).toEqual(["NONE", null, "generic shape"]);
    expect(state({ version: 1, active: true })).toEqual(["READY", 1, "3D v1"]);
    expect(state({ version: 2, status: "PENDING" }, { version: 1, active: true })).toEqual([
      "PENDING",
      1,
      "3D v1 · generating",
    ]);
    expect(state({ version: 1, status: "PENDING" })).toEqual(["PENDING", null, "generic shape · generating"]);
    expect(state({ version: 2, status: "FAILED" }, { version: 1, active: true })).toEqual([
      "FAILED",
      1,
      "3D v1 · generation failed",
    ]);
    expect(state({ version: 1, status: "FAILED" })).toEqual(["FAILED", null, "generic shape · generation failed"]);
    // A failure older than the rendered version is history, not the model's state.
    expect(state({ version: 2, active: true }, { version: 1, status: "FAILED" })).toEqual(["READY", 2, "3D v2"]);
    // A retired version says nothing; a ready one that is not rendered is not "the asset".
    expect(state({ version: 2, status: "RETIRED" }, { version: 1, active: true })).toEqual(["READY", 1, "3D v1"]);
    expect(state({ version: 1, status: "RETIRED" })).toEqual(["NONE", null, "generic shape"]);
    expect(state({ version: 1, status: "READY", active: false })).toEqual(["NONE", null, "generic shape"]);
  });
});
