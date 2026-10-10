import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { deviceSections } from "@/components/device/device-shell";
import { factorySections, plcSections } from "@/components/plc/stored-plc-shell";
import { AppShell } from "@/components/shell/app-shell";
import type { TreeNode } from "@/components/shell/side-bar";
import { buildLlmIndex, routePattern } from "@/lib/agent/llm-index";
import type { DeviceDetailView } from "@/lib/domain/device-detail-view";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import { ACTIVITIES } from "@/lib/navigation/activities";

/**
 * Active-feature navigation (TASK-1005): every entry a sidebar offers opens a screen the
 * LLM Index lists, and nothing without a screen is offered. The ids are placeholders, so
 * an entry's route turns back into the pattern the index carries.
 */
const F = "factoryId";
const P = "plcId";
const V = "deviceId";

const indexPatterns = new Set(buildLlmIndex().areas.flatMap((area) => area.routes.map((route) => route.pattern)));

/** Every entry links to a screen of the index; none is muted or a dead end. */
function expectActive(entries: readonly TreeNode[]) {
  expect(entries.length).toBeGreaterThan(0);
  for (const entry of entries) {
    expect(entry.href, `${String(entry.label)} has a route`).toBeDefined();
    expect(entry.muted ?? false, `${String(entry.label)} is not muted`).toBe(false);
    expect(
      indexPatterns.has(routePattern(entry.href!)),
      `${String(entry.label)} → ${entry.href} is in the LLM Index`,
    ).toBe(true);
  }
}

const plcView = (overrides: Partial<PlcConfigurationView> = {}): PlcConfigurationView => ({
  plc: {
    id: P,
    factoryId: F,
    name: "PLC-01",
    role: null,
    runtimeStatus: "STOPPED",
    architectureType: "COMPACT",
    ioMappingVersion: 0,
    modbusMappingVersion: 0,
  },
  model: {
    id: "m",
    manufacturer: "Generic / simulated",
    family: "Generic PLC",
    modelName: "Generic compact PLC",
    sku: null,
    verificationStatus: "GENERIC",
    categoryCode: "PLC",
    capabilities: ["PROGRAMMABLE"],
    runtimeSupport: "OPENPLC",
  },
  electrical: null,
  ports: [],
  rack: null,
  banks: [],
  occupancy: { total: 0, occupied: 0 },
  peripherals: [],
  ...overrides,
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
      { key: "runtime", label: "Runtime" },
    ],
    programNote: null,
    ports: [],
    wires: [],
    registers: [],
    parameters: null,
    ...overrides,
  }) as unknown as DeviceDetailView;

describe("the activity bar", () => {
  it("offers only entries with a screen: no settings gear", () => {
    render(
      <AppShell title="t" activity="factories" status={{ left: [] }}>
        <p>content</p>
      </AppShell>,
    );
    const bar = within(screen.getByRole("navigation", { name: "Activities" }));
    expect(bar.queryByLabelText("Settings")).toBeNull();
    expect(bar.getAllByLabelText(/./)).toHaveLength(ACTIVITIES.length);
    for (const activity of ACTIVITIES) expect(bar.getByLabelText(activity.label)).toBeInTheDocument();
  });
});

describe("the PLC section list", () => {
  it("lists the PLC's screens, every one in the LLM Index, and no Logs", () => {
    const entries = plcSections(plcView(), "overview");
    expectActive(entries);
    expect(entries.map((entry) => entry.label)).toEqual([
      "Overview",
      "Hardware / Pinout",
      "Connections",
      "Communication",
      "Program",
      "I/O Mapping",
      "Versions",
      "Runtime",
      "Export",
    ]);
    expect(entries.map((entry) => entry.label)).not.toContain("Logs");
  });

  it("keeps the factory's screens apart, narrowed to the PLC where they can be", () => {
    const entries = factorySections(plcView());
    expectActive(entries);
    expect(entries.map((entry) => [entry.label, entry.href])).toEqual([
      ["Simulator", `/factories/${F}/simulator`],
      ["Live Tags", `/factories/${F}/tags?plc=${P}`],
      ["Events", `/factories/${F}/events?device=${P}`],
    ]);
  });

  it("omits Program and Versions for a model that is not programmable", () => {
    const entries = plcSections(plcView({ model: { ...plcView().model, capabilities: [] } }), "overview");
    expectActive(entries);
    expect(entries.map((entry) => entry.label)).not.toContain("Program");
    expect(entries.map((entry) => entry.label)).not.toContain("Versions");
  });
});

describe("the device section list", () => {
  it("lists only screens that exist, in the LLM Index, and names the simulator as such", () => {
    const entries = deviceSections(device(), "overview");
    expectActive(entries);
    expect(entries.map((entry) => [entry.label, entry.meta ?? ""])).toEqual([
      ["Overview", ""],
      ["Connections", "0"],
      ["Parameters", ""],
      ["Simulator", "factory"],
      ["Live Tags", "factory"],
      ["Events", "factory"],
    ]);
  });

  it("drops the program screens of a programmable model without an adapter, and sections without a screen", () => {
    const entries = deviceSections(
      device({
        sections: [
          { key: "overview", label: "Overview" },
          { key: "hardware", label: "Hardware / Pinout" },
          { key: "program", label: "Program" },
          { key: "versions", label: "Versions" },
          { key: "parameters", label: "Parameters" },
        ],
        programNote: "no adapter for this model",
      }),
      "overview",
    );
    expectActive(entries);
    expect(entries.map((entry) => entry.label)).toEqual(["Overview", "Parameters", "Live Tags", "Events"]);
  });
});
