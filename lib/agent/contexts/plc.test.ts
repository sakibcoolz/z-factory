import { describe, expect, it } from "vitest";
import type { PlcCommunicationView } from "@/lib/domain/plc-communication-view";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import type { PlcRuntimeView, PlcVersionsView } from "@/lib/domain/plc-runtime-view";
import { LLM_CONTEXT_SECTIONS } from "../llm-context";
import { buildPlcContext, type PlcContextSection } from "./plc";

const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";
const V = "01a10a0d-e48d-744e-ba58-dfb344f7e884";
const factory = { id: F, name: "Pump House" };

const point = (
  label: string,
  status: "FREE" | "OCCUPIED",
  ioType: "DI" | "DO" = "DO",
): PlcConfigurationView["banks"][number]["points"][number] => ({
  id: `${label}-id`,
  ioType,
  label,
  vendorAddress: null,
  logicalAddress: `%QX0.${label.length}`,
  signalTypes: ["DIGITAL_24V"],
  status,
  device: status === "OCCUPIED" ? { id: V, name: "XV-101", terminalLabel: "Y1" } : null,
  tagName: status === "OCCUPIED" ? "XV_101_Y1" : null,
});

const view = (overrides: Partial<PlcConfigurationView> = {}): PlcConfigurationView => ({
  plc: {
    id: P,
    factoryId: F,
    name: "PLC-01",
    role: "Pump station",
    runtimeStatus: "STOPPED",
    architectureType: "COMPACT",
    ioMappingVersion: 1,
    modbusMappingVersion: 1,
  },
  model: {
    id: "model-1",
    manufacturer: "Siemens",
    family: "S7-1200",
    modelName: "CPU 1214C DC/DC/DC",
    sku: "6ES7214-1AG40-0XB0",
    verificationStatus: "VERIFIED",
    categoryCode: "PLC",
    capabilities: ["PROGRAMMABLE", "IEC_61131_3"],
    runtimeSupport: "OPENPLC",
  },
  electrical: null,
  ports: [{ name: "X1", physicalType: "RJ45", protocols: ["PROFINET", "MODBUS_TCP"], portCount: 1 }],
  rack: null,
  banks: [
    {
      key: "do",
      label: "Built-in DO",
      ioType: "DO",
      slotIndex: null,
      points: [point("Qa.0", "OCCUPIED"), point("Qa.1", "FREE")],
    },
    { key: "di", label: "Built-in DI", ioType: "DI", slotIndex: null, points: [point("Ia.0", "FREE", "DI")] },
  ],
  occupancy: { total: 3, occupied: 1 },
  peripherals: [
    {
      deviceId: V,
      name: "XV-101",
      role: null,
      modelName: "Generic on/off valve, 24 V DC",
      categoryName: "Valve",
      connection: "DIRECT_IO",
      protocols: [],
      wires: [
        { terminalLabel: "Y1", ioType: "DO", pointLabel: "Qa.0", logicalAddress: "%QX0.0", tagName: "XV_101_Y1" },
      ],
    },
  ],
  ...overrides,
});

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

describe("the PLC context", () => {
  it("names the screen, keeps the common PLC facts and links every other screen", () => {
    const context = buildPlcContext({ factory, view: view(), section: "overview" });

    expect(context.identity).toMatchObject({
      page: "PLC overview",
      area: "plc",
      route: `/factories/${F}/plcs/${P}`,
      routePattern: "/factories/[factoryId]/plcs/[plcId]",
      subject: "PLC-01 (Pump House)",
    });
    expect(context.context.find((item) => item.label === "Model")).toMatchObject({
      value: "Siemens CPU 1214C DC/DC/DC",
      href: "/catalog?model=model-1",
    });
    expect(context.context.find((item) => item.label === "I/O")?.value).toBe("1/3 channels used");
    expect(labels(context.objects)).toEqual(["XV-101", "Port X1"]);
    expect(context.relationships).toEqual([
      expect.objectContaining({ label: "XV-101 is wired to PLC-01", value: "Y1 → Qa.0 (%QX0.0)" }),
    ]);
    expect(context.capacity.map((item) => item.value)).toEqual(["2 of 3 free", "1 of 2 DO free", "1 of 1 DI free"]);
    expect(context.validation.status).toBe("ok");
    expect(labels(context.actions)).toEqual(["Delete PLC", "Open hardware", "Open the catalog record"]);
    // The screen itself is not in its own navigation; every other screen is.
    expect(labels(context.navigation)).not.toContain("Overview");
    expect(labels(context.navigation)).toEqual(
      expect.arrayContaining(["Hardware", "Program", "Runtime", "Export", "Designer", "Live tags"]),
    );
    expect(context.navigation.find((item) => item.label === "Live tags")?.href).toBe(`/factories/${F}/tags?plc=${P}`);
    // No container id, port or secret.
    expect(JSON.stringify(context)).not.toMatch(/containerId|apiHostPort|secret|token|password/i);
  });

  it("flags an empty PLC and a full bank, and asks what it should control", () => {
    const empty = view({
      peripherals: [],
      occupancy: { total: 1, occupied: 1 },
      banks: [{ key: "do", label: "Built-in DO", ioType: "DO", slotIndex: null, points: [point("Qa.0", "OCCUPIED")] }],
    });
    const context = buildPlcContext({ factory, view: empty, section: "io-mapping" });
    expect(labels(context.validation.items)).toEqual(["Nothing is wired to this PLC", "No free channel"]);
    expect(context.validation.status).toBe("issues");
    expect(labels(context.decisions)).toEqual(["What should this PLC control?"]);
    expect(context.actions).toEqual([
      expect.objectContaining({ label: "Change the wiring in the designer", href: `/factories/${F}/designer` }),
    ]);
  });

  it("adds the rack, installable modules and the module decision for a modular PLC", () => {
    const modular = view({
      plc: { ...view().plc, architectureType: "MODULAR" },
      rack: {
        name: "Rack 0",
        slotCount: 3,
        slots: [
          {
            slotIndex: 1,
            module: {
              id: "m1",
              modelName: "SM 1223 DI8/DO8",
              sku: null,
              moduleType: "DI_DO",
              pointCount: 16,
              occupiedCount: 1,
            },
          },
          { slotIndex: 2, module: null },
          { slotIndex: 3, module: null },
        ],
      },
    });
    const context = buildPlcContext({
      factory,
      view: modular,
      section: "hardware",
      installable: [
        {
          id: "im1",
          modelName: "SM 1231 AI4",
          sku: null,
          moduleType: "AI",
          channels: [{ ioType: "AI", count: 4, signalType: "ANALOG_4_20MA", acceptedSignalTypes: ["ANALOG_4_20MA"] }],
        },
      ],
    });
    expect(context.identity.page).toBe("PLC hardware");
    expect(labels(context.objects)).toEqual([
      "XV-101",
      "Slot 1: SM 1223 DI8/DO8",
      "Port X1",
      "Installable: SM 1231 AI4",
    ]);
    expect(context.capacity.at(-1)).toMatchObject({ label: "Rack slots", value: "2 of 3 free" });
    expect(labels(context.decisions)).toEqual(["Which modules?"]);
    expect(context.actions.find((item) => item.label === "Install module")?.detail).toMatch(
      /1 compatible module model offered/,
    );
  });

  it("describes the runtime screen from the runtime view, with every operation and its warning", () => {
    const runtime: PlcRuntimeView = {
      state: "RUNNING",
      created: true,
      serviceName: "plc-01",
      runtimeVersion: "OpenPLC 2024.1",
      image: "zfactory/openplc:2024.1",
      modbus: { bindAddress: "127.0.0.1", hostPort: 15002 },
      selectedProgram: { version: 2, status: "DEPLOYED" },
      deployedProgram: { version: 2 },
      events: [
        {
          id: "e1",
          type: "DEVICE_FAULTED",
          severity: "CRITICAL",
          occurredAt: "2026-10-09T10:00:00.000Z",
          detail: "start failed",
        },
      ],
      liveError: "The Docker Engine is not reachable.",
    };
    const context = buildPlcContext({
      factory,
      view: view({ plc: { ...view().plc, runtimeStatus: "RUNNING" } }),
      section: "runtime",
      runtime,
    });

    expect(context.identity).toMatchObject({ page: "PLC runtime", area: "runtime" });
    expect(context.context.find((item) => item.label === "Modbus TCP endpoint")?.value).toBe("127.0.0.1:15002");
    expect(context.context.find((item) => item.label === "Real state")?.value).toBe("Running (stored)");
    expect(context.objects.find((item) => item.label === "DEVICE_FAULTED")?.tone).toBe("fault");
    expect(labels(context.validation.items)).toEqual(["The live state could not be read"]);
    expect(labels(context.actions)).toEqual(["Start", "Deploy", "Restart", "Stop", "Remove", "Refresh state"]);
    expect(context.actions.find((item) => item.label === "Stop")).toMatchObject({ tone: "warn" });
    expect(context.actions.find((item) => item.label === "Start")).toMatchObject({
      tone: "info",
      detail: "Already running.",
    });
    expect(labels(context.decisions)).toEqual(["The runtime is running"]);
    expect(JSON.stringify(context)).not.toContain("plc-01");
  });

  it("lists versions with their status and gates Deploy now on a runtime", () => {
    const versions: PlcVersionsView = {
      versions: [
        {
          id: "v2",
          version: 2,
          status: "FAILED",
          checksum: "b",
          createdAt: "2026-10-09T10:00:00.000Z",
          selected: false,
        },
        {
          id: "v1",
          version: 1,
          status: "COMPILED",
          checksum: "a",
          createdAt: "2026-10-09T09:00:00.000Z",
          selected: true,
        },
      ],
      deployments: [],
      runtimeCreated: false,
    };
    const context = buildPlcContext({ factory, view: view(), section: "versions", versions });
    expect(context.identity).toMatchObject({ page: "PLC versions", area: "program" });
    // The common objects first, then the screen's own: the versions with their status.
    expect(context.objects.map((item) => [item.label, item.tone])).toEqual([
      ["XV-101", undefined],
      ["Port X1", undefined],
      ["Version 2", "fault"],
      ["Version 1", "ok"],
    ]);
    expect(labels(context.validation.items)).toEqual(["A version failed to compile or deploy"]);
    expect(context.actions.find((item) => item.label === "Deploy now")?.detail).toMatch(/Disabled/);
  });

  it("reads the program screen: starter program, no versions, and the control-logic decision", () => {
    const context = buildPlcContext({
      factory,
      view: view(),
      section: "program",
      program: {
        versions: [],
        source: "PROGRAM main ... END_PROGRAM",
        sourceVersion: null,
        locatedVariables: [{ name: "XV_101_Y1", address: "%QX0.0", type: "BOOL", source: "XV-101 · Y1" }],
        maxSourceBytes: 262144,
      },
      runtime: {
        ...({} as PlcRuntimeView),
        state: "STOPPED",
        created: false,
        deployedProgram: null,
        events: [],
        liveError: null,
        modbus: null,
        selectedProgram: null,
        image: null,
        runtimeVersion: null,
        serviceName: null,
      },
    });
    expect(context.context.find((item) => item.label === "Editor opens")?.value).toBe("the starter program");
    expect(context.context.find((item) => item.label === "Located variables")?.detail).toBe(
      "XV_101_Y1 AT %QX0.0: BOOL",
    );
    expect(labels(context.validation.items)).toEqual(["No program version stored"]);
    expect(labels(context.decisions)).toEqual(["Control logic"]);
    expect(context.actions.find((item) => item.label === "Save & deploy")?.href).toBe(
      `/factories/${F}/plcs/${P}/runtime`,
    );
  });

  it("reads links and their health on the communication screen", () => {
    const communication: PlcCommunicationView = {
      plcId: P,
      factoryId: F,
      peers: [{ plcId: "peer", name: "PLC-02", runtimeStatus: "RUNNING", servesModbus: true }],
      links: [
        {
          link: {
            id: "l1",
            factoryId: F,
            relationship: "MODBUS_TCP_CLIENT_SERVER",
            protocol: "MODBUS_TCP",
            source: { plcId: P, name: "PLC-01" },
            target: { plcId: "peer", name: "PLC-02" },
            client: "SOURCE",
            clientPlcId: P,
            serverPlcId: "peer",
            serverHost: "plc-02",
            serverPort: 502,
            unitId: 1,
            pollIntervalMs: 500,
            enabled: true,
            configVersion: 3,
            mappingCount: 2,
            createdAt: "2026-10-09T09:00:00.000Z",
            updatedAt: "2026-10-09T09:00:00.000Z",
          },
          role: "client",
          peer: { plcId: "peer", name: "PLC-02" },
          health: {
            quality: "STALE",
            reason: "no answer for 2 s",
            since: "2026-10-09T10:00:00.000Z",
            checkedAt: "2026-10-09T10:00:02.000Z",
          },
          deployedVersion: 2,
          mappings: [],
          options: null,
        } as unknown as PlcCommunicationView["links"][number],
      ],
      watched: true,
    };
    const context = buildPlcContext({ factory, view: view(), section: "communication", communication });
    expect(context.identity).toMatchObject({ page: "PLC communication", area: "plc-communication" });
    expect(context.relationships.at(-1)).toMatchObject({
      label: "PLC-01 is the client of a MODBUS_TCP link with PLC-02",
      value: "0 mappings · enabled · every 500 ms",
      tone: "warn",
    });
    expect(labels(context.validation.items)).toEqual([
      "Link with PLC-02 is stale",
      "Link with PLC-02 changed since it was deployed",
    ]);
    expect(labels(context.decisions)).toContain("Which PLC is the client?");
    // The server's host and port stay on the page; the context names the peer only.
    expect(JSON.stringify(context)).not.toMatch(/plc-02|502/);
  });

  it("gives every section a complete document with the ten sections", () => {
    const sections: PlcContextSection[] = [
      "overview",
      "hardware",
      "connections",
      "io-mapping",
      "program",
      "versions",
      "runtime",
      "communication",
      "export",
    ];
    for (const section of sections) {
      const context = buildPlcContext({ factory, view: view(), section });
      for (const { id } of LLM_CONTEXT_SECTIONS) expect(context).toHaveProperty(id);
      expect(context.identity.route).toContain(`/plcs/${P}`);
      expect(context.navigation.map((item) => item.href)).not.toContain(context.identity.route);
    }
    const exported = buildPlcContext({ factory, view: view(), section: "export" });
    expect(exported.actions.find((item) => item.label === "Download plc.json")?.href).toBe(
      `/factories/${F}/plcs/${P}/export/files/plc.json`,
    );
  });
});
