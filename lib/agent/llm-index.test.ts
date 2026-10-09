import { describe, expect, it } from "vitest";
import { ACTIVITIES } from "@/lib/navigation/activities";
import { routes } from "@/lib/navigation/routes";
import { areasWithLlmContext, buildLlmIndex, routePattern } from "./llm-index";
import { LLM_INDEX_SECTIONS, renderLlmIndexMarkdown } from "./llm-index-markdown";

/**
 * The LLM Index (TASK-1001) is derived from the route registry and the activity bar. These
 * tests are the drift guard: a screen that is added to `routes` without a place in the
 * index, or an activity without an area, fails here.
 */
const index = buildLlmIndex();
const markdown = renderLlmIndexMarkdown(index);

describe("the LLM Index covers the application", () => {
  it("lists every route builder exactly once, as a screen or as a file", () => {
    const listed = [
      ...index.areas.flatMap((area) => area.routes.map((route) => route.key)),
      ...index.files.map((f) => f.key),
    ];
    const counts = new Map<string, number>();
    for (const key of listed) counts.set(key, (counts.get(key) ?? 0) + 1);
    // `newDevice` is listed twice on purpose: compact and modular are two screens.
    const unexpectedDuplicates = [...counts].filter(([key, count]) => count > 1 && key !== "newDevice");
    expect(unexpectedDuplicates).toEqual([]);
    expect(new Set(listed)).toEqual(new Set(Object.keys(routes)));
  });

  it("has at least one area under every activity-bar entry, and the LLM entry itself", () => {
    for (const activity of ACTIVITIES) {
      expect(
        index.areas.some((area) => area.activity === activity.key),
        `no area under activity ${activity.key}`,
      ).toBe(true);
    }
    expect(index.activities.map((activity) => activity.key)).toEqual(ACTIVITIES.map((activity) => activity.key));
    expect(index.activities.find((activity) => activity.key === "llm")).toMatchObject({
      short: "LLM",
      factoryScoped: false,
    });
  });

  it("turns builder results into placeholder patterns without a query string", () => {
    expect(routePattern(routes.plcHardware("factoryId", "plcId", "DI0"))).toBe(
      "/factories/[factoryId]/plcs/[plcId]/hardware",
    );
    expect(routePattern(routes.catalog({ model: "x" }))).toBe("/catalog");
    expect(index.areas.flatMap((area) => area.routes.map((route) => route.pattern))).toContain(
      "/factories/[factoryId]/devices/new/modular",
    );
    expect(index.files.map((file) => file.pattern)).toContain(
      "/factories/[factoryId]/plcs/[plcId]/export/files/[file]",
    );
    // Every pattern is a real path: no encoded placeholder, no stray id word.
    for (const pattern of [
      ...index.areas.flatMap((a) => a.routes.map((r) => r.pattern)),
      ...index.files.map((f) => f.pattern),
    ]) {
      expect(pattern).toMatch(/^\/[a-zA-Z0-9\-/[\].]*$/);
      expect(pattern).not.toMatch(/\/(factoryId|plcId|deviceId|moduleId|connectionId|linkId|assetId)(\/|$)/);
    }
  });

  it("tells an agent where PLC, device, wiring, simulation, runtime and export tasks go", () => {
    const where = (word: RegExp) =>
      index.areas
        .filter((area) => area.tasks.some((task) => word.test(task)) || word.test(area.purpose))
        .map((a) => a.key);
    expect(where(/\bPLC\b/)).toContain("devices");
    expect(where(/\bPLC\b/)).toContain("plc");
    expect(where(/device/i)).toContain("designer");
    expect(where(/wir/i)).toContain("designer");
    expect(where(/simulat|fault/i)).toContain("simulation");
    expect(where(/start or stop/i)).toContain("runtime");
    expect(where(/export|snapshot/i)).toContain("export");
    // Every workflow step points at a listed area.
    for (const step of index.workflow) expect(index.areas.map((area) => area.key)).toContain(step.area);
  });

  it("says which pages have an LLM Context tab, derived from the areas", () => {
    expect(areasWithLlmContext(index)).toEqual(index.areas.filter((area) => area.llmContext));
    // TASK-1002 and TASK-1003 flip this per area; the index then names them.
    if (areasWithLlmContext(index).length === 0) expect(markdown).toContain("None yet. The LLM Context tab is added");
  });
});

describe("the LLM Index as Markdown", () => {
  it("has every section, every area and every route", () => {
    for (const section of LLM_INDEX_SECTIONS) expect(markdown).toContain(`## ${section.title}`);
    for (const area of index.areas) {
      expect(markdown).toContain(`### ${area.label}`);
      for (const route of area.routes) expect(markdown).toContain(`| \`${route.pattern}\` |`);
    }
    for (const file of index.files) expect(markdown).toContain(`| \`${file.pattern}\` |`);
    expect(markdown.endsWith("\n")).toBe(true);
  });

  it("states the non-bypass rules and the user-confirmation expectation", () => {
    expect(markdown).toContain("Use the normal Z-Factory UI and its validation");
    expect(markdown).toContain("No direct database manipulation");
    expect(markdown).toContain("No hidden runtime writes");
    expect(markdown).toContain("Never force a physical output");
    expect(markdown).toContain("ADR-0015");
    expect(markdown).toContain("Ask before material engineering decisions");
    expect(markdown).toContain("Never invent vendor facts");
    expect(markdown).toContain("no embedded model and no MCP");
  });
});
