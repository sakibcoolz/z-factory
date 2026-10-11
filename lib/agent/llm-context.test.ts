import { describe, expect, it } from "vitest";
import type { DeviceTreeNode } from "@/lib/domain/device-tree";
import type { FactoryDeviceView } from "@/lib/domain/plc-config-view";
import type { FactoryView } from "@/lib/services/factory-service";
import type { FactoryPlcSummary } from "@/lib/services/plc-config-service";
import { buildFactoryOverviewContext } from "./contexts/factory-overview";
import { LLM_CONTEXT_AREAS } from "./contexts/registry";
import {
  createLlmContext,
  LLM_CONTEXT_LIST_SECTIONS,
  LLM_CONTEXT_SECTIONS,
  type LlmContextDocument,
  renderLlmContextMarkdown,
} from "./llm-context";
import { buildLlmIndex } from "./llm-index";

const identity = {
  page: "Factory overview",
  area: "factory",
  route: "/factories/f1",
  routePattern: "/factories/[factoryId]",
  subject: "Pump House",
  summary: "One factory.",
};

describe("an LLM Context document", () => {
  it("always has the ten sections, in order, with empty lists and an ok validation by default", () => {
    const document = createLlmContext(identity);
    expect(LLM_CONTEXT_SECTIONS.map((section) => section.id)).toEqual([
      "identity",
      "context",
      "objects",
      "relationships",
      "capacity",
      "validation",
      "actions",
      "constraints",
      "decisions",
      "navigation",
    ]);
    for (const section of LLM_CONTEXT_LIST_SECTIONS) {
      // The navigation is never empty: it ends with the generated upstream and downstream areas (TASK-1004).
      if (section === "navigation") expect(document.navigation.every((item) => item.relation)).toBe(true);
      else expect(document[section]).toEqual([]);
    }
    expect(document.validation).toEqual({ status: "ok", items: [] });
    expect(document.version).toBe(1);
    expect(document.identity).toEqual(identity);
  });

  it("derives the validation status from its items unless told otherwise", () => {
    const warned = createLlmContext(identity, { validation: { items: [{ label: "No PLC", tone: "warn" }] } });
    expect(warned.validation.status).toBe("issues");
    const informed = createLlmContext(identity, { validation: { items: [{ label: "note", tone: "info" }] } });
    expect(informed.validation.status).toBe("ok");
    const unknown = createLlmContext(identity, { validation: { status: "unknown" } });
    expect(unknown.validation).toEqual({ status: "unknown", items: [] });
  });

  it("renders as Markdown with one heading per section and links for items with a route", () => {
    const markdown = renderLlmContextMarkdown(
      createLlmContext(identity, {
        actions: [{ label: "Edit factory", href: "/factories/f1/edit", detail: "Name and description." }],
        decisions: [{ label: "Which PLC?", tone: "warn", decision: { kind: "model", confirm: "required" } }],
      }),
    );
    expect(markdown.startsWith("# LLM Context — Factory overview: Pump House\n")).toBe(true);
    for (const section of LLM_CONTEXT_SECTIONS) expect(markdown).toContain(`## ${section.title}`);
    expect(markdown).toContain("- [Edit factory](/factories/f1/edit) — Name and description.");
    expect(markdown).toContain("- Which PLC? — model · confirm before acting (warn)");
    expect(markdown).toContain("Status: ok");
    expect((markdown.match(/^None\.$/gm) ?? []).length).toBe(6);
    expect(markdown).toContain("- [Before: Factories](/factories)");
  });

  it("registers every area with a context as an area of the LLM Index, and the index names them", () => {
    const index = buildLlmIndex();
    for (const key of LLM_CONTEXT_AREAS) expect(index.areas.map((area) => area.key)).toContain(key);
    expect(new Set(index.areas.filter((area) => area.llmContext).map((area) => area.key))).toEqual(LLM_CONTEXT_AREAS);
    expect(LLM_CONTEXT_AREAS.has("factory")).toBe(true);
  });
});

const factoryView = (overrides: Partial<FactoryView> = {}): FactoryView => ({
  id: "01a10a0d-e48d-744e-ba58-dfb344f7e880",
  name: "Pump House",
  slug: "pump-house",
  description: null,
  status: "DRAFT",
  runtimeStatus: "STOPPED",
  dockerNetworkName: "zfactory_01a10a0d-e48d-744e-ba58-dfb344f7e880",
  subnetCidr: "172.20.1.0/24",
  deviceCount: 0,
  plcCount: 0,
  lastEvent: null,
  createdAt: "2026-10-09T10:00:00.000Z",
  updatedAt: "2026-10-09T10:00:00.000Z",
  ...overrides,
});

const device = (overrides: Partial<FactoryDeviceView>): FactoryDeviceView => ({
  id: "01a10a0d-e48d-744e-ba58-dfb344f7e8ff",
  name: "DEV",
  role: null,
  modelName: "Generic",
  manufacturer: "Generic / simulated",
  categoryCode: "VALVE",
  categoryName: "Valve",
  architectureType: null,
  runtimeStatus: "STOPPED",
  ...overrides,
});

const plc = device({
  id: "01a10a0d-e48d-744e-ba58-dfb344f7e883",
  name: "PLC-01",
  role: "Pump station",
  modelName: "CPU 1214C DC/DC/DC",
  manufacturer: "Siemens",
  categoryCode: "PLC",
  categoryName: "PLC / programmable controller",
  architectureType: "COMPACT",
  runtimeStatus: "RUNNING",
});
const valve = device({ id: "01a10a0d-e48d-744e-ba58-dfb344f7e884", name: "XV-101", runtimeStatus: "FAULTED" });
const stray = device({ id: "01a10a0d-e48d-744e-ba58-dfb344f7e885", name: "XV-900" });

const tree: DeviceTreeNode<FactoryDeviceView>[] = [
  { device: plc, children: [{ device: valve, children: [] }] },
  { device: stray, children: [] },
];

const plcSummary: FactoryPlcSummary = {
  id: plc.id,
  name: plc.name,
  architectureType: "COMPACT",
  runtimeStatus: "RUNNING",
  programSelected: false,
  ioMappingVersion: 3,
  occupancy: { total: 14, occupied: 2 },
};

const labels = (items: readonly { label: string }[]) => items.map((item) => item.label);

describe("the factory overview context", () => {
  it("tells an agent what is missing in an empty, stopped factory", () => {
    const context = buildFactoryOverviewContext({
      factory: factoryView(),
      devices: [],
      plcs: [],
      docker: { reachable: true, version: "29.7.2" },
    });

    expect(context.identity).toMatchObject({
      page: "Factory overview",
      area: "factory",
      route: "/factories/01a10a0d-e48d-744e-ba58-dfb344f7e880",
      routePattern: "/factories/[factoryId]",
      subject: "Pump House",
    });
    expect(context.objects).toEqual([]);
    expect(context.capacity).toEqual([expect.objectContaining({ label: "No PLC", tone: "warn" })]);
    expect(context.validation.status).toBe("issues");
    expect(labels(context.validation.items)).toEqual(["No PLC"]);
    expect(labels(context.decisions)).toEqual(["Which PLC?", "What should the plant do?"]);
    // Stopped: delete is offered, start is the runtime action.
    expect(context.actions.find((action) => action.label === "Delete factory")?.tone).toBe("warn");
    expect(context.actions.find((action) => action.label === "Start factory")?.href).toBe(
      "/factories/01a10a0d-e48d-744e-ba58-dfb344f7e880/runtime",
    );
    expect(context.navigation.map((item) => item.label)).not.toContain("Export PLC-01");
    expect(context.context.find((item) => item.label === "Docker Engine")).toMatchObject({
      value: "29.7.2",
      tone: "ok",
    });
  });

  it("reads devices, relationships, capacity and issues from what the page shows", () => {
    const context = buildFactoryOverviewContext({
      factory: factoryView({ runtimeStatus: "DEGRADED", deviceCount: 3, plcCount: 1 }),
      devices: tree,
      plcs: [plcSummary],
      docker: { reachable: false },
    });

    expect(labels(context.objects)).toEqual(["PLC-01", "XV-101", "XV-900"]);
    expect(context.objects[0]).toMatchObject({
      href: `/factories/${factoryView().id}/plcs/${plc.id}`,
      detail: "Pump station · Running",
      tone: "ok",
    });
    expect(context.objects[1]).toMatchObject({
      href: `/factories/${factoryView().id}/devices/${valve.id}`,
      tone: "fault",
    });
    expect(labels(context.relationships)).toEqual([
      "PLC-01 is a PLC root",
      "XV-101 is connected to PLC-01",
      "XV-900 is connected to nothing",
    ]);
    expect(context.capacity).toEqual([
      expect.objectContaining({
        label: "PLC-01",
        value: "2/14 channels used, 12 free",
        href: `/factories/${factoryView().id}/plcs/${plc.id}/hardware`,
      }),
    ]);
    expect(context.validation.status).toBe("issues");
    expect(labels(context.validation.items)).toEqual([
      "Docker Engine unreachable",
      "Factory is degraded",
      "XV-101 is faulted",
      "PLC-01 has no program selected",
      "XV-900 is not connected",
    ]);
    expect(labels(context.decisions)).toEqual(["Control logic for PLC-01", "The factory is running"]);
    // Running: delete is not available, the runtime action is stop.
    expect(context.actions.find((action) => action.label === "Delete factory")?.detail).toMatch(
      /stop the factory first/,
    );
    expect(labels(context.actions)).toContain("Stop factory");
    expect(context.navigation.find((item) => item.label === "Export PLC-01")?.href).toBe(
      `/factories/${factoryView().id}/plcs/${plc.id}/export`,
    );
    // Nothing secret: no container id, port or credential appears anywhere in the document.
    expect(JSON.stringify(context)).not.toMatch(/secret|password|token|containerId|apiHostPort/i);
  });

  it("is a complete document the renderer accepts", () => {
    const context: LlmContextDocument = buildFactoryOverviewContext({
      factory: factoryView(),
      devices: tree,
      plcs: [plcSummary],
      docker: { reachable: true },
    });
    const markdown = renderLlmContextMarkdown(context);
    expect(markdown).toContain("## Capacity and availability\n\n- [PLC-01](");
    expect(markdown).toContain("Status: issues");
  });
});
