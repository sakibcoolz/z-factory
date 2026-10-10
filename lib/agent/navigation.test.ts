import { describe, expect, it } from "vitest";
import { createLlmContext } from "./llm-context";
import { buildLlmIndex } from "./llm-index";
import { renderLlmIndexMarkdown } from "./llm-index-markdown";
import { AREA_GUIDANCE, crossPageLinks, intentIndex, routeIds } from "./navigation";

const F = "01a10a0d-e48d-744e-ba58-dfb344f7e880";
const P = "01a10a0d-e48d-744e-ba58-dfb344f7e883";
const index = buildLlmIndex();
const areaKeys = index.areas.map((area) => area.key);

/** The task's examples: a user's intention and the area the index must send an agent to. */
const EXAMPLES: Array<[intent: RegExp, area: string]> = [
  [/add a pump/i, "designer"],
  [/find a model for a pump/i, "catalog"],
  [/select or configure a PLC/i, "plc"],
  [/connect a sensor/i, "designer"],
  [/available AI, DI, DO or AO/i, "plc"],
  [/test high temperature/i, "simulation"],
  [/Thin Client Agent configuration/i, "export"],
  [/understand the whole plant/i, "factory"],
];

describe("the navigation guidance", () => {
  it("covers every area of the LLM Index, and names only areas that exist", () => {
    expect(Object.keys(AREA_GUIDANCE).sort()).toEqual([...areaKeys].sort());
    for (const [key, guidance] of Object.entries(AREA_GUIDANCE)) {
      expect(guidance.intents.length, `${key} has intents`).toBeGreaterThan(0);
      for (const other of [...guidance.upstream, ...guidance.downstream])
        expect(areaKeys, `${key} → ${other}`).toContain(other);
      expect(guidance.upstream, `${key} is not its own upstream`).not.toContain(key);
      expect(guidance.downstream, `${key} is not its own downstream`).not.toContain(key);
    }
    // The index carries the same guidance, so the page and the Markdown render it.
    for (const area of index.areas) {
      expect(area.intents).toEqual(AREA_GUIDANCE[area.key]!.intents);
      expect(area.upstream).toEqual(AREA_GUIDANCE[area.key]!.upstream);
    }
  });

  it("sends the task's example intentions to the right area", () => {
    const intents = intentIndex();
    for (const [pattern, area] of EXAMPLES) {
      const hits = intents.filter((entry) => pattern.test(entry.intent));
      expect(hits.length, `an intent matching ${pattern}`).toBeGreaterThan(0);
      expect(
        hits.map((hit) => hit.area),
        `${pattern} → ${area}`,
      ).toContain(area);
    }
  });

  it("opens an area for the ids at hand, and only then", () => {
    expect(AREA_GUIDANCE.designer!.open({ factoryId: F })).toBe(`/factories/${F}/designer`);
    expect(AREA_GUIDANCE.designer!.open({})).toBeUndefined();
    expect(AREA_GUIDANCE.program!.open({ factoryId: F, plcId: P })).toBe(`/factories/${F}/plcs/${P}/program`);
    expect(AREA_GUIDANCE.program!.open({ factoryId: F })).toBeUndefined();
    expect(AREA_GUIDANCE.catalog!.open({})).toBe("/catalog");
    expect(AREA_GUIDANCE.devices!.open({ factoryId: F })).toBe(`/factories/${F}/devices/new/compact`);
  });

  it("reads the ids a route carries", () => {
    expect(routeIds(`/factories/${F}/plcs/${P}/runtime`)).toEqual({ factoryId: F, plcId: P });
    expect(routeIds(`/factories/${F}/devices/dev-1/parameters`)).toEqual({ factoryId: F, deviceId: "dev-1" });
    expect(routeIds(`/factories/${F}/modules/mod-1`)).toEqual({ factoryId: F, moduleId: "mod-1" });
    expect(routeIds(`/factories/${F}/devices/new/compact`)).toEqual({ factoryId: F });
    expect(routeIds("/factories/new")).toEqual({});
    expect(routeIds(`/factories/${F}/tags?plc=${P}`)).toEqual({ factoryId: F });
    expect(routeIds("/catalog?model=x")).toEqual({});
  });

  it("gives a page its upstream and downstream areas with routes where the ids allow", () => {
    const links = crossPageLinks("plc", { factoryId: F, plcId: P });
    expect(links.map((link) => [link.relation, link.area, link.href])).toEqual([
      ["upstream", "designer", `/factories/${F}/designer`],
      ["upstream", "devices", `/factories/${F}/devices/new/compact`],
      ["downstream", "program", `/factories/${F}/plcs/${P}/program`],
      ["downstream", "plc-communication", `/factories/${F}/plcs/${P}/communication`],
      ["downstream", "runtime", `/factories/${F}/runtime`],
      ["downstream", "export", `/factories/${F}/plcs/${P}/export`],
    ]);
    // Without a PLC id, the PLC areas are named but not linked.
    const fromFactory = crossPageLinks("factory", { factoryId: F });
    expect(fromFactory.find((link) => link.area === "export")?.href).toBeUndefined();
    expect(fromFactory.find((link) => link.area === "designer")?.href).toBe(`/factories/${F}/designer`);
    expect(crossPageLinks("unknown", {})).toEqual([]);
  });
});

describe("cross-page links in a page's LLM Context", () => {
  it("are appended to the navigation from the page's route, labelled and deduplicated", () => {
    const document = createLlmContext(
      {
        page: "PLC program",
        area: "program",
        route: `/factories/${F}/plcs/${P}/program`,
        routePattern: "/factories/[factoryId]/plcs/[plcId]/program",
        subject: "PLC-01",
        summary: "",
      },
      { navigation: [{ label: "Runtime", href: `/factories/${F}/runtime` }] },
    );
    const generated = document.navigation.filter((item) => item.relation);
    expect(generated.map((item) => [item.relation, item.label, item.href])).toEqual([
      ["upstream", "PLC hardware and I/O", `/factories/${F}/plcs/${P}`],
      ["downstream", "Simulator and scenarios", `/factories/${F}/simulator`],
      ["downstream", "PLC engineering export", `/factories/${F}/plcs/${P}/export`],
    ]);
    // The runtime link the page already had is not repeated; the generated items carry the area's purpose.
    expect(document.navigation.filter((item) => item.href === `/factories/${F}/runtime`)).toHaveLength(1);
    expect(generated[0]?.detail).toMatch(/PLC as hardware/);
  });

  it("names an area it cannot link, and knows no area for a page outside the index", () => {
    const list = createLlmContext({
      page: "Factories",
      area: "factories",
      route: "/factories",
      routePattern: "/factories",
      subject: "workspace",
      summary: "",
    });
    expect(list.navigation.map((item) => [item.relation, item.label, item.href])).toEqual([
      ["upstream", "LLM Index", "/llm-index"],
      ["downstream", "Factory overview and settings", undefined],
      ["downstream", "Device catalog", "/catalog"],
    ]);
    const none = createLlmContext({
      page: "x",
      area: "nowhere",
      route: "/x",
      routePattern: "/x",
      subject: "x",
      summary: "",
    });
    expect(none.navigation).toEqual([]);
  });
});

describe("the LLM Index's Where to go", () => {
  it("lists every intent with its area and first route, and the flow between areas", () => {
    const markdown = renderLlmIndexMarkdown(index);
    expect(markdown).toContain("## Where to go");
    expect(markdown).toContain(
      "| add a pump, valve, sensor, drive or motor to the plant | Designer | `/factories/[factoryId]/designer` |",
    );
    expect(markdown).toContain(
      "| find available AI, DI, DO or AO channels | PLC hardware and I/O | `/factories/[factoryId]/plcs/[plcId]` |",
    );
    expect(markdown).toContain(
      "- PLC program and versions: after PLC hardware and I/O; before Runtime, Simulator and scenarios, PLC engineering export",
    );
    expect(markdown).toContain(
      "- Before: Device catalog, Factory overview and settings, Device configuration; after: PLC hardware and I/O, Topology and 3D view, PLC program and versions",
    );
  });
});
