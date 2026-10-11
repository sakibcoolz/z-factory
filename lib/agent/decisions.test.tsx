import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { LlmContextPanel } from "@/components/agent/llm-context";
import type { PlcConfigurationView } from "@/lib/domain/plc-config-view";
import type { TopologyView } from "@/lib/domain/topology-view";
import type { FactoryView } from "@/lib/services/factory-service";
import { buildTopologyContext } from "./contexts/design-pages";
import { buildPlcContext } from "./contexts/plc";
import { createLlmContext, DECISION_KINDS, DECISION_RULE, renderLlmContextMarkdown } from "./llm-context";
import { buildLlmIndex } from "./llm-index";
import { renderLlmIndexMarkdown } from "./llm-index-markdown";

/**
 * User-decision guidance (TASK-1006): every missing decision names its kind, whether the
 * user must confirm, a safe default when one exists, and what validation enforces.
 */
const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";

const kinds = Object.keys(DECISION_KINDS);

const point = (
  label: string,
  status: "FREE" | "OCCUPIED",
  signalTypes: string[],
): PlcConfigurationView["banks"][number]["points"][number] => ({
  id: label,
  ioType: "DI",
  label,
  vendorAddress: null,
  logicalAddress: `%IX0.${label.length}`,
  signalTypes,
  status,
  device: null,
  tagName: null,
});

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
    manufacturer: "Siemens",
    family: "S7-1200",
    modelName: "CPU 1214C",
    sku: null,
    verificationStatus: "VERIFIED",
    categoryCode: "PLC",
    capabilities: ["PROGRAMMABLE"],
    runtimeSupport: "OPENPLC",
  },
  electrical: null,
  ports: [{ name: "X1", physicalType: "RJ45", protocols: ["PROFINET", "MODBUS_TCP"], portCount: 1 }],
  rack: null,
  banks: [
    {
      key: "di",
      label: "Built-in DI",
      ioType: "DI",
      slotIndex: null,
      points: [point("Ia.0", "FREE", ["DIGITAL_24V", "DIGITAL_NAMUR"]), point("Ia.1", "FREE", ["DIGITAL_24V"])],
    },
  ],
  occupancy: { total: 2, occupied: 0 },
  peripherals: [
    {
      deviceId: "d",
      name: "XV-101",
      role: null,
      modelName: "Generic valve",
      categoryName: "Valve",
      connection: "DIRECT_IO",
      protocols: [],
      wires: [],
    },
  ],
  ...overrides,
});

describe("decision guidance on the PLC screens", () => {
  it("asks for the signal standard, the channel and the protocol where more than one is compatible, with defaults and what is enforced", () => {
    const context = buildPlcContext({ factory: { id: F, name: "Pump House" }, view: plcView(), section: "hardware" });
    const by = (label: string) => context.decisions.find((item) => item.label === label);

    expect(by("Which signal standard?")).toMatchObject({
      value: "1 free point accepts more than one",
      detail: "e.g. Ia.0: DIGITAL_24V, DIGITAL_NAMUR",
      decision: { kind: "signal-standard", confirm: "required", defaultChoice: expect.stringContaining("terminal") },
    });
    expect(by("Which signal standard?")?.decision.enforced).toMatch(/mismatch is refused/);
    expect(by("Which channel?")).toMatchObject({
      value: "Built-in DI: 2 free",
      decision: { kind: "channel", confirm: "optional", defaultChoice: expect.stringContaining("first free") },
    });
    expect(by("Which protocol?")).toMatchObject({
      value: "X1: PROFINET, MODBUS_TCP",
      decision: { kind: "protocol", confirm: "optional", defaultChoice: expect.stringContaining("Modbus TCP") },
    });
    // Every decision carries its guidance with a known kind.
    for (const item of context.decisions) {
      expect(kinds, item.label).toContain(item.decision.kind);
      expect(["required", "optional"]).toContain(item.decision.confirm);
    }
  });

  it("asks nothing it does not need: one standard per point, one free channel, one protocol", () => {
    const context = buildPlcContext({
      factory: { id: F, name: "Pump House" },
      view: plcView({
        ports: [{ name: "X1", physicalType: "RJ45", protocols: ["MODBUS_TCP"], portCount: 1 }],
        banks: [
          {
            key: "di",
            label: "Built-in DI",
            ioType: "DI",
            slotIndex: null,
            points: [point("Ia.0", "FREE", ["DIGITAL_24V"])],
          },
        ],
        occupancy: { total: 1, occupied: 0 },
      }),
      section: "overview",
    });
    expect(context.decisions.map((item) => item.label)).toEqual([]);
  });
});

describe("decision guidance in the designer", () => {
  it("asks which PLC to wire to when more than one could take a device", () => {
    const factory: FactoryView = {
      id: F,
      name: "Pump House",
      slug: "pump-house",
      description: null,
      status: "DRAFT",
      runtimeStatus: "STOPPED",
      dockerNetworkName: "n",
      subnetCidr: "172.20.1.0/24",
      deviceCount: 2,
      plcCount: 2,
      lastEvent: null,
      createdAt: "",
      updatedAt: "",
    };
    const node = (id: string, name: string): TopologyView["nodes"][number] => ({
      id,
      name,
      role: null,
      categoryCode: "PLC",
      categoryName: "PLC",
      manufacturer: "Siemens",
      modelName: "CPU",
      architectureType: "COMPACT",
      runtimeStatus: "STOPPED",
      x: 0,
      y: 0,
      placed: true,
    });
    const view: TopologyView = {
      factory: { id: F, name: "Pump House", slug: "pump-house", runtimeStatus: "STOPPED" },
      nodes: [node(P, "PLC-01"), node("p2", "PLC-02")],
      edges: [],
      palette: [],
    };
    const context = buildTopologyContext({ factory, view, mode: "designer" });
    const which = context.decisions.find((item) => item.label === "Which PLC to wire to?");
    expect(which).toMatchObject({ value: "PLC-01, PLC-02", decision: { kind: "endpoint", confirm: "required" } });
    for (const item of context.decisions) expect(kinds).toContain(item.decision.kind);
  });
});

describe("decision guidance in the framework", () => {
  const document = createLlmContext(
    {
      page: "PLC hardware",
      area: "plc",
      route: `/factories/${F}/plcs/${P}/hardware`,
      routePattern: "/factories/[factoryId]/plcs/[plcId]/hardware",
      subject: "PLC-01",
      summary: "",
    },
    {
      decisions: [
        {
          label: "Which channel?",
          detail: "More than one is free.",
          decision: {
            kind: "channel",
            confirm: "optional",
            defaultChoice: "the first free compatible channel",
            enforced: "Occupied channels are refused.",
          },
        },
        { label: "Which model?", decision: { kind: "model", confirm: "required" } },
      ],
    },
  );

  it("renders the guidance in the Markdown", () => {
    const markdown = renderLlmContextMarkdown(document);
    expect(markdown).toContain(
      "- Which channel? — More than one is free. — channel · a default may be applied · default: the first free compatible channel · enforced: Occupied channels are refused.",
    );
    expect(markdown).toContain("- Which model? — model · confirm before acting");
  });

  it("renders the guidance in the panel, named for agents", () => {
    render(<LlmContextPanel document={document} />);
    const decisions = within(screen.getByRole("region", { name: "Missing decisions and recommended questions" }));
    const channel = decisions.getByText("Which channel?").closest("li") as HTMLElement;
    const guidance = channel.querySelector("[data-llm-decision]") as HTMLElement;
    expect(guidance.dataset.llmDecision).toBe("channel");
    expect(guidance.dataset.llmConfirm).toBe("optional");
    expect(guidance.textContent).toContain("default: the first free compatible channel");
    expect(guidance.textContent).toContain("enforced: Occupied channels are refused.");
    const model = decisions.getByText("Which model?").closest("li") as HTMLElement;
    expect(model.querySelector("[data-llm-confirm]")?.textContent).toContain("confirm before acting");
  });
});

describe("the LLM Index's decisions section", () => {
  it("states the rule and every kind", () => {
    const markdown = renderLlmIndexMarkdown(buildLlmIndex());
    expect(markdown).toContain("## Decisions to ask the user");
    expect(markdown).toContain(DECISION_RULE);
    for (const [kind, meaning] of Object.entries(DECISION_KINDS))
      expect(markdown).toContain(`| \`${kind}\` | ${meaning} |`);
    expect(DECISION_RULE).toMatch(/never overrides/);
  });
});
