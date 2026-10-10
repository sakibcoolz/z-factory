import { describe, expect, it } from "vitest";
import type { CatalogModelDetail, CatalogOverview, PeripheralCompatibility } from "@/lib/domain/catalog-view";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";
import type { FactoryDeviceView, PlcModelOption } from "@/lib/domain/plc-config-view";
import type { FactorySceneView } from "@/lib/domain/scene-view";
import type { TopologyView } from "@/lib/domain/topology-view";
import type { FactoryView } from "@/lib/services/factory-service";
import { LLM_CONTEXT_SECTIONS } from "../llm-context";
import { buildLlmIndex } from "../llm-index";
import {
  buildCatalogContext,
  buildDeviceContext,
  buildFactoriesContext,
  buildNewPlcContext,
  buildTopologyContext,
  buildView3dContext,
} from "./design-pages";
import { LLM_CONTEXT_AREAS } from "./registry";

const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";
const V = "01a10a0d-e48d-744e-ba58-dfb344f7e884";

const factory = (overrides: Partial<FactoryView> = {}): FactoryView => ({
  id: F,
  name: "Pump House",
  slug: "pump-house",
  description: null,
  status: "DRAFT",
  runtimeStatus: "STOPPED",
  dockerNetworkName: `zfactory_${F}`,
  subnetCidr: "172.20.1.0/24",
  deviceCount: 2,
  plcCount: 1,
  lastEvent: null,
  createdAt: "2026-10-10T06:00:00.000Z",
  updatedAt: "2026-10-10T06:00:00.000Z",
  ...overrides,
});

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);
const complete = (document: ReturnType<typeof buildTopologyContext>) => {
  for (const { id } of LLM_CONTEXT_SECTIONS) expect(document).toHaveProperty(id);
  expect(document.navigation.map((item) => item.href)).not.toContain(document.identity.route);
};

describe("the registry after PR C", () => {
  it("names every area of the LLM Index, so every engineering page has a panel", () => {
    const index = buildLlmIndex();
    const expected = index.areas.map((area) => area.key).filter((key) => key !== "llm-index");
    expect([...LLM_CONTEXT_AREAS].sort()).toEqual(expected.sort());
    expect(index.areas.filter((area) => !area.llmContext).map((area) => area.key)).toEqual(["llm-index"]);
  });
});

const topology: TopologyView = {
  factory: { id: F, name: "Pump House", slug: "pump-house", runtimeStatus: "STOPPED" },
  nodes: [
    {
      id: P,
      name: "PLC-01",
      role: "Pump station",
      categoryCode: "PLC",
      categoryName: "PLC / programmable controller",
      manufacturer: "Siemens",
      modelName: "CPU 1214C",
      architectureType: "COMPACT",
      runtimeStatus: "RUNNING",
      x: 0,
      y: 0,
      placed: true,
    },
    {
      id: V,
      name: "XV-101",
      role: null,
      categoryCode: "VALVE",
      categoryName: "Valve",
      manufacturer: "Generic",
      modelName: "Generic valve",
      architectureType: null,
      runtimeStatus: "FAULTED",
      x: 1,
      y: 1,
      placed: false,
    },
    {
      id: "loose",
      name: "PT-900",
      role: null,
      categoryCode: "SENSOR",
      categoryName: "Sensor",
      manufacturer: "Generic",
      modelName: "Generic PT",
      architectureType: null,
      runtimeStatus: "STOPPED",
      x: 2,
      y: 2,
      placed: true,
    },
  ],
  edges: [
    {
      id: "e1",
      relationship: "WIRED_TO",
      sourceId: P,
      targetId: V,
      wires: [
        {
          id: "w1",
          kind: "SIGNAL",
          from: {
            deviceId: V,
            deviceName: "XV-101",
            type: "TERMINAL",
            endpointId: "t",
            label: "Y1",
            name: "XV-101 / Y1",
          },
          to: {
            deviceId: P,
            deviceName: "PLC-01",
            type: "IO_POINT",
            endpointId: "p",
            label: "Qa.0",
            name: "PLC-01 / Qa.0",
          },
          tagName: "XV_101_Y1",
          logicalAddress: "%QX0.0",
        },
      ],
      protocol: null,
    } as unknown as TopologyView["edges"][number],
  ],
  palette: [
    {
      categoryCode: "VALVE",
      categoryName: "Valve",
      items: [{ modelId: "m", modelName: "Generic valve", manufacturer: "Generic", architectureType: null }],
    },
  ],
};

describe("the designer and topology contexts", () => {
  it("reads nodes, edges with their wires, the palette and the loose and faulted devices", () => {
    const context = buildTopologyContext({ factory: factory(), view: topology, mode: "designer" });
    expect(context.identity).toMatchObject({
      page: "Designer",
      area: "designer",
      routePattern: "/factories/[factoryId]/designer",
    });
    expect(labels(context.objects)).toEqual(["PLC-01", "XV-101", "PT-900"]);
    expect(context.objects[1]?.detail).toBe("Faulted · not placed yet (grid slot)");
    expect(context.relationships).toEqual([
      expect.objectContaining({
        label: "PLC-01 is wired to XV-101",
        value: "1 wire",
        detail: "XV-101 / Y1 → PLC-01 / Qa.0 (XV_101_Y1)",
      }),
    ]);
    expect(labels(context.validation.items)).toEqual(["PT-900 is connected to nothing", "XV-101 is faulted"]);
    expect(labels(context.actions)).toContain("Connect two devices");
    expect(labels(context.decisions)).toEqual([
      "Which model for a new device?",
      "Which relationship, when the canvas asks?",
    ]);
    expect(context.navigation.find((item) => item.label === "PLC-01 hardware")?.href).toBe(
      `/factories/${F}/plcs/${P}/hardware`,
    );
    complete(context);

    const readOnly = buildTopologyContext({
      factory: factory({ runtimeStatus: "RUNNING" }),
      view: { ...topology, nodes: [] },
      mode: "topology",
    });
    expect(readOnly.identity).toMatchObject({ page: "Topology", area: "topology" });
    expect(readOnly.actions).toEqual([
      expect.objectContaining({ label: "Edit in designer", href: `/factories/${F}/designer` }),
    ]);
    expect(labels(readOnly.validation.items)).toEqual(["No PLC"]);
    expect(labels(readOnly.decisions)).toEqual([
      "Which PLC?",
      "Which model for a new device?",
      "Which relationship, when the canvas asks?",
      "The factory is running",
    ]);
  });
});

describe("the 3D view context", () => {
  it("describes the scene as a visualization with its devices and assets", () => {
    const scene = {
      factory: { id: F, name: "Pump House", slug: "pump-house", runtimeStatus: "STOPPED" },
      devices: [
        {
          id: P,
          name: "PLC-01",
          role: null,
          categoryCode: "PLC",
          categoryName: "PLC",
          manufacturer: "Siemens",
          modelId: "m1",
          modelName: "CPU 1214C",
          isPlc: true,
          runtimeStatus: "STOPPED",
          asset: { id: "a", version: 2, url: "/assets/models/a/model.glb", scale: null, rotationYDeg: 0 },
        },
        {
          id: V,
          name: "XV-101",
          role: null,
          categoryCode: "VALVE",
          categoryName: "Valve",
          manufacturer: "Generic",
          modelId: "m2",
          modelName: "Generic valve",
          isPlc: false,
          runtimeStatus: "STOPPED",
          asset: null,
        },
      ],
      connections: [{ id: "c1", relationship: "CONTROLS", sourceId: P, targetId: V }],
      extent: 6,
    } as unknown as FactorySceneView;
    const context = buildView3dContext({ factory: factory(), scene });
    expect(context.identity).toMatchObject({
      page: "3D view",
      area: "topology",
      routePattern: "/factories/[factoryId]/view-3d",
    });
    expect(context.context.find((item) => item.label === "With a catalog asset")?.value).toBe("1/2");
    expect(context.objects[0]).toMatchObject({
      label: "PLC-01",
      href: `/factories/${F}/plcs/${P}`,
      detail: "Stopped · asset v2",
    });
    expect(labels(context.relationships)).toEqual(["PLC-01 controls XV-101"]);
    expect(context.constraints[0]?.label).toBe("Visualization only");
    complete(context);
  });
});

const device = (overrides: Partial<DeviceDetailView> = {}): DeviceDetailView =>
  ({
    id: V,
    factoryId: F,
    factoryName: "Pump House",
    factorySlug: "pump-house",
    name: "XV-101",
    role: null,
    location: null,
    runtimeStatus: "STOPPED",
    categoryCode: "VALVE",
    categoryName: "Valve",
    manufacturer: "Generic",
    modelId: "m2",
    modelName: "Generic valve",
    architectureType: null,
    runtimeSupport: "NONE",
    simulatorType: "VALVE",
    capabilities: ["DIRECT_IO"],
    sections: [
      { key: "overview", label: "Overview" },
      { key: "connections", label: "Connections" },
      { key: "parameters", label: "Parameters" },
    ],
    programNote: null,
    ports: [],
    wires: [
      {
        id: "w1",
        kind: "SIGNAL",
        from: {
          deviceId: V,
          deviceName: "XV-101",
          type: "TERMINAL",
          endpointId: "t",
          label: "Y1",
          name: "XV-101 / Y1",
        },
        to: {
          deviceId: P,
          deviceName: "PLC-01",
          type: "IO_POINT",
          endpointId: "p",
          label: "Qa.0",
          name: "PLC-01 / Qa.0",
        },
        tagName: "XV_101_Y1",
        logicalAddress: "%QX0.0",
      },
    ],
    registers: [
      {
        tagName: "XV_101_Y1",
        plcId: P,
        plcName: "PLC-01",
        role: "COMMAND",
        dataType: "BOOL",
        logicalAddress: "%QX0.0",
        area: "COIL",
        address: 0,
        displayAddress: "00001",
        signal: "open",
        unit: null,
      },
    ],
    parameters: {
      fields: [{ key: "travelS", label: "Travel time", unit: "s", min: 0, max: 60, step: 1 }],
      values: { travelS: 5 },
      applied: true,
      versions: [],
    },
    ...overrides,
  }) as unknown as DeviceDetailView;

describe("the device contexts", () => {
  it("reads the model, wires, tags and PLC on the overview, and links the other screens", () => {
    const context = buildDeviceContext({ device: device(), section: "overview" });
    expect(context.identity).toMatchObject({
      page: "Device overview",
      area: "devices",
      route: `/factories/${F}/devices/${V}`,
      routePattern: "/factories/[factoryId]/devices/[deviceId]",
      subject: "XV-101 (Pump House)",
    });
    expect(context.context.find((item) => item.label === "Model")).toMatchObject({
      value: "Generic Generic valve",
      href: "/catalog?model=m2",
    });
    expect(labels(context.objects)).toEqual(["Wire XV-101 / Y1 → PLC-01 / Qa.0", "Tag XV_101_Y1"]);
    expect(labels(context.relationships)).toEqual([
      "XV-101 / Y1 is wired to PLC-01 / Qa.0",
      "XV-101 is read and driven by PLC-01",
    ]);
    expect(context.validation.status).toBe("ok");
    expect(labels(context.navigation)).toEqual(
      expect.arrayContaining(["Connections", "Parameters", "Designer", "Simulator"]),
    );
    expect(labels(context.navigation)).not.toContain("Overview");
    complete(context);
  });

  it("explains the parameters screen, and flags a device wired to nothing", () => {
    const parameters = buildDeviceContext({ device: device(), section: "parameters" });
    expect(parameters.identity).toMatchObject({
      page: "Device parameters",
      routePattern: "/factories/[factoryId]/devices/[deviceId]/parameters",
    });
    expect(parameters.objects.find((item) => item.label === "Parameter travelS")?.value).toBe("5");
    expect(parameters.actions[0]).toMatchObject({ label: "Save parameters", tone: "warn" });
    expect(labels(parameters.decisions)).toEqual(["Which parameter values?"]);

    const loose = buildDeviceContext({
      device: device({
        wires: [],
        registers: [],
        runtimeStatus: "FAULTED",
        parameters: { fields: [], values: {}, applied: false, versions: [] },
      }),
      section: "parameters",
    });
    expect(labels(loose.validation.items)).toEqual([
      "Not connected to anything",
      "The device is faulted",
      "Parameters are kept for the record only",
    ]);
    expect(loose.decisions).toEqual([]);
  });
});

describe("the new PLC context", () => {
  it("lists the models offered, the existing PLCs and the decisions to ask", () => {
    const models: PlcModelOption[] = [
      {
        id: "m1",
        manufacturer: "Siemens",
        family: "S7-1200",
        modelName: "CPU 1214C",
        sku: "6ES7",
        verificationStatus: "VERIFIED",
        io: "14 DI · 10 DO · 2 AI",
        ports: "1 × PROFINET",
      },
    ];
    const existing: FactoryDeviceView = {
      id: P,
      name: "PLC-01",
      role: null,
      modelName: "CPU 1214C",
      manufacturer: "Siemens",
      categoryCode: "PLC",
      categoryName: "PLC",
      architectureType: "COMPACT",
      runtimeStatus: "STOPPED",
    };
    const context = buildNewPlcContext({
      factory: factory(),
      architecture: "compact",
      models,
      devices: [existing],
      suggestedName: "PLC-02",
    });
    expect(context.identity).toMatchObject({
      page: "New compact PLC",
      area: "devices",
      routePattern: "/factories/[factoryId]/devices/new/compact",
    });
    expect(context.objects[0]).toMatchObject({
      label: "Siemens CPU 1214C",
      value: "14 DI · 10 DO · 2 AI",
      href: "/catalog?model=m1",
    });
    expect(labels(context.relationships)).toEqual(["PLC-01 already exists"]);
    expect(context.context.find((item) => item.label === "Suggested name")?.value).toBe("PLC-02");
    expect(labels(context.decisions)).toEqual(["Which model?", "Compact or modular?", "The process role"]);
    expect(context.actions.find((item) => item.label === "Switch to modular")?.href).toBe(
      `/factories/${F}/devices/new/modular`,
    );
    complete(context);

    const empty = buildNewPlcContext({
      factory: factory(),
      architecture: "modular",
      models: [],
      devices: [],
      suggestedName: "PLC-01",
    });
    expect(labels(empty.validation.items)).toEqual(["The catalog has no modular PLC"]);
  });
});

const overview: CatalogOverview = {
  manufacturers: [],
  categories: [
    { code: "PLC", name: "PLC / programmable controller", modelCount: 3 },
    { code: "VALVE", name: "Valve", modelCount: 2 },
  ],
  totals: { models: 5, manufacturers: 2, verified: 2, generic: 3, withAsset: 1 },
};

describe("the catalog context", () => {
  it("reads the totals, the selected model with its source, and a PLC's compatible peripherals", () => {
    const model = {
      id: "m1",
      modelName: "CPU 1214C",
      sku: "6ES7",
      architectureType: "COMPACT",
      verificationStatus: "VERIFIED",
      asset: { state: "FAILED", activeVersion: null },
      manufacturer: "Siemens",
      family: "S7-1200",
      categoryCode: "PLC",
      categoryName: "PLC / programmable controller",
      runtimeSupport: "OPENPLC",
      controlCapability: "PROGRAMMABLE",
      lifecycleStatus: "ACTIVE",
      source: {
        url: "https://example.invalid/1214c",
        title: "S7-1200 manual",
        revision: "V4.5",
        retrievedAt: "2026-10-01",
        verifiedAt: "2026-10-02",
      },
      electrical: null,
      ports: [],
      builtInChannels: [{ ioType: "DI", count: 14, signalType: "DIGITAL_24V", acceptedSignalTypes: ["DIGITAL_24V"] }],
      terminals: [],
      facts: {},
      assetVersions: [],
      placeholderKind: "cabinet",
      racks: [],
      modules: [],
    } as unknown as CatalogModelDetail;
    const peripherals = [
      {
        modelId: "m2",
        manufacturer: "Generic",
        modelName: "Generic valve",
        categoryCode: "VALVE",
        categoryName: "Valve",
        verificationStatus: "GENERIC",
        controlCapability: "DIRECT_IO",
        directIo: {
          compatible: true,
          terminals: [{ terminalLabel: "Y1", required: "DO", signalType: "DIGITAL_24V", satisfied: true, modules: [] }],
        },
      },
      {
        modelId: "m3",
        manufacturer: "Generic",
        modelName: "Generic AI sensor",
        categoryCode: "SENSOR",
        categoryName: "Sensor",
        verificationStatus: "GENERIC",
        controlCapability: "DIRECT_IO",
        directIo: {
          compatible: false,
          terminals: [
            { terminalLabel: "OUT", required: "AI", signalType: "ANALOG_4_20MA", satisfied: false, modules: [] },
          ],
        },
      },
    ] as unknown as PeripheralCompatibility[];
    const context = buildCatalogContext({ overview, model, peripherals, type: "PLC" });
    expect(context.identity).toMatchObject({
      page: "Device catalog",
      area: "catalog",
      route: "/catalog?model=m1&type=PLC",
      subject: "Siemens CPU 1214C",
    });
    expect(context.context.find((item) => item.label === "Verification")).toMatchObject({
      value: "verified",
      tone: "ok",
    });
    expect(context.context.find((item) => item.label === "Verification")?.detail).toContain("S7-1200 manual");
    expect(context.context.find((item) => item.label === "Built-in I/O")?.value).toBe("14 DI");
    expect(context.objects.find((item) => item.label === "PLC / programmable controller")?.tone).toBe("ok");
    expect(labels(context.relationships)).toEqual([
      "Generic Generic valve can be wired to CPU 1214C",
      "Generic Generic AI sensor cannot be fully wired to CPU 1214C",
    ]);
    expect(context.relationships[1]?.tone).toBe("warn");
    expect(context.capacity[0]?.value).toBe("1 of 2");
    expect(labels(context.validation.items)).toEqual(["The model's 3D asset generation failed"]);
    complete(context);

    const none = buildCatalogContext({ overview, model: null });
    expect(none.identity.subject).toBe("all models");
    expect(none.relationships).toEqual([]);
  });
});

describe("the Factories context", () => {
  it("lists factories with their state and subnet, and the first-run case", () => {
    const list = buildFactoriesContext({
      factories: [
        factory(),
        factory({ id: "02", name: "Line 2", slug: "line-2", subnetCidr: "172.20.2.0/24", runtimeStatus: "DEGRADED" }),
      ],
      docker: { reachable: false },
    });
    expect(list.identity).toMatchObject({
      page: "Factories",
      area: "factories",
      route: "/factories",
      routePattern: "/factories",
    });
    expect(list.objects.map((item) => [item.label, item.tone])).toEqual([
      ["Pump House", "info"],
      ["Line 2", "warn"],
    ]);
    expect(list.capacity[0]?.value).toBe("172.20.1.0/24, 172.20.2.0/24");
    expect(labels(list.validation.items)).toEqual(["Docker Engine unreachable", "Line 2 is degraded"]);
    expect(list.actions.find((item) => item.label === "New factory")?.href).toBe("/factories/new");
    complete(list);

    const empty = buildFactoriesContext({ factories: [], docker: { reachable: true, version: "29.7.2" } });
    expect(empty.identity.summary).toContain("first run");
    expect(empty.objects).toEqual([]);
    expect(empty.validation.status).toBe("ok");
  });
});
