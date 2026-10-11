// @vitest-environment node
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { loadModuleTypes } from "@/lib/process-modules";
import { ingestModuleTypes } from "@/lib/process-modules/ingest";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { getModule, listModules } from "@/lib/services/process-module-service";
import { getTopology } from "@/lib/services/topology-service";
import { openTestDb, resetDb } from "../integration/harness";
import { type AppServer, startAppServer } from "./app-server";
import { type AgentReport, BrowserAgent, type Question } from "./browser-agent";
import { Browser, findChromium, type Page } from "./cdp";

/**
 * TASK-1008: a browser agent builds the reference design through the normal UI only. It
 * starts at the LLM Index, reads every page's LLM Context, asks the user each decision the
 * context requires, and the result passes the application's own validation. Runs with
 * `TEST_BROWSER=1` against a Chromium (`CHROME_BIN`, or the one Playwright cached) and the
 * production build of this tree (`npm run build`), on the integration-test database.
 */
const enabled = process.env.TEST_BROWSER === "1" && Boolean(process.env.TEST_DATABASE_URL);
const describeBrowser = enabled ? describe : describe.skip;

const OWNER = "browser-agent";

/** The user's answers, by the question the agent asks. An unknown question fails the run. */
const ANSWERS: Array<[RegExp, string]> = [
  [/name for the factory/i, "Tank farm"],
  [/subnet/i, "172.20.77.0/24"],
  [/^Which PLC\?/i, "compact"],
  [/PLC model|model.*PLC|^Which model\?/i, "Generic RTU"],
  [/model for the level transmitter/i, "Generic level transmitter, 4–20 mA"],
  [/model for the inlet valve/i, "Generic on/off valve, 24 V DC"],
  [/model for the pump/i, "Generic centrifugal pump"],
  [/model for the motor/i, "Generic three-phase motor"],
  [/model for the drive/i, "Generic VFD, hardwired control"],
  [/which relationship/i, "drives"],
  [/control logic/i, "Keep the starter program for now: no control strategy has been decided."],
  [/which process/i, "Tank"],
  [/which profile/i, "LEVEL"],
  [/name for the module/i, "TANK-01"],
  [/device for level transmitter/i, "SENSOR-01"],
  [/device for inlet valve/i, "VALVE-01"],
];

const scriptedUser = {
  decide(question: Question): string {
    const match = ANSWERS.find(([pattern]) => pattern.test(question.label));
    if (!match) {
      throw new Error(
        `The agent asked a question the script has no answer for: "${question.label}" (${question.kind}) on ${question.page}`,
      );
    }
    return match[1];
  },
};

describe("the browser agent", () => {
  it("knows the application from its pages only: no service, database, Docker or application import", () => {
    for (const file of ["browser-agent.ts", "cdp.ts"]) {
      const source = readFileSync(join(__dirname, file), "utf8");
      const imports = [...source.matchAll(/^import .* from "([^"]+)";$/gm)].map((match) => match[1]!);
      expect(imports.length, `${file} has imports`).toBeGreaterThan(0);
      for (const specifier of imports) {
        expect(specifier, `${file} imports ${specifier}`).toMatch(/^(node:|\.\/)/);
      }
      expect(source).not.toMatch(/@\/lib|prisma|dockerode|\bpg\b|localhost:5432/);
    }
  });
});

describeBrowser("a browser agent building the tank design through the UI", () => {
  let db: PrismaClient;
  let server: AppServer;
  let browser: Browser;
  let page: Page;
  let report: AgentReport;
  let failure: unknown;

  beforeAll(async () => {
    const chromium = findChromium();
    if (!chromium) throw new Error("No Chromium found: set CHROME_BIN or install a Playwright browser.");
    db = openTestDb();
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    await ingestModuleTypes(db, loadModuleTypes());
    server = await startAppServer({ databaseUrl: process.env.TEST_DATABASE_URL!, ownerId: OWNER });
    browser = await Browser.launch(chromium);
    page = await browser.newPage();

    const out = process.env.TEST_BROWSER_OUT;
    if (out) mkdirSync(out, { recursive: true });
    const agent = new BrowserAgent(page, server.baseUrl, scriptedUser, { screenshots: out });
    try {
      report = await agent.run();
    } catch (error) {
      failure = error;
      report = {
        visits: agent.visits,
        index: agent.index,
        asked: agent.asked,
        defaulted: agent.defaulted,
        changes: agent.changes,
        capacity: agent.capacity,
        validation: agent.validation,
        design: agent.design,
        blocked: agent.blocked,
        markdown: "",
      };
      if (out) await page.screenshot(join(out, "failure.png"));
    }
    if (out) writeFileSync(join(out, "report.md"), report.markdown || JSON.stringify(report, null, 2));
  }, 300_000);

  afterAll(async () => {
    await page?.close();
    await browser?.close();
    await server?.stop();
    await db?.$disconnect();
  }, 60_000);

  it("completes the scenario without a refusal", () => {
    if (failure) {
      const context = [
        `Pages: ${report.visits.map((visit) => visit.route).join(" → ")}`,
        `Asked: ${report.asked.map((q) => `${q.label} → ${q.answer}`).join("; ")}`,
        `Changes: ${report.changes.join("; ")}`,
        server
          .output()
          .split("\n")
          .filter((line) => /error|warn/i.test(line))
          .slice(-10)
          .join("\n"),
      ].join("\n");
      throw new Error(`${String(failure)}\n${context}`, { cause: failure });
    }
    expect(report.changes.length).toBeGreaterThan(10);
  });

  it("starts at the LLM Index and reads its parts before the first page", () => {
    expect(report.visits[0]?.route).toBe("/llm-index");
    expect(report.index.sections).toEqual(
      expect.arrayContaining(["areas", "navigation", "decisions", "validation", "workflow", "rules"]),
    );
    expect(report.index.areas).toEqual(expect.arrayContaining(["factories", "designer", "plc", "modules"]));
    expect(report.index.workflow.length).toBeGreaterThan(5);
  });

  it("reads the LLM Context of every page it works on; only the index and the factory form have none", () => {
    const without = report.visits.filter((visit) => !visit.context).map((visit) => visit.route);
    expect(without).toEqual(["/llm-index", "/factories/new"]);
    expect(report.visits.map((visit) => visit.area)).toEqual(
      expect.arrayContaining(["factories", "factory", "devices", "plc", "designer", "modules"]),
    );
  });

  it("asks the user every required decision and applies only the optional defaults", () => {
    const labels = report.asked.map((question) => question.label);
    expect(labels).toEqual(
      expect.arrayContaining([
        "Which name for the factory?",
        "Which subnet for the factory's network?",
        "Which PLC?",
        "Which model for the level transmitter?",
        "Which model for the inlet valve?",
        "Which model for the pump?",
        "Which model for the motor?",
        "Which model for the drive for the motor?",
        "Which relationship, when the canvas asks?",
        "Control logic",
        "Which process, and which devices play which role?",
        "Which device for Level transmitter?",
        "Which device for Inlet valve?",
      ]),
    );
    expect(report.asked.every((question) => question.confirm === "required")).toBe(true);
    // Every question offered the page's choices, except the free-text names and the control logic.
    for (const question of report.asked.filter((q) => q.kind !== "name" && q.kind !== "control-logic")) {
      expect(question.options?.length, question.label).toBeGreaterThan(0);
    }
    // The channel is an optional decision with a default: applied, recorded, not asked.
    expect(report.defaulted.map((question) => question.label)).toEqual([
      "Which channel?",
      "Which channel?",
      "Which channel?",
      "Which channel?",
    ]);
    expect(labels).not.toContain("Which channel?");
  });

  it("confirmed the PLC's capacity from the context before wiring", () => {
    expect(report.capacity).toContainEqual(expect.stringMatching(/^All channels: \d+ of \d+ free$/));
    expect(report.capacity).toContainEqual(expect.stringMatching(/\d+ of \d+ AI free$/));
    expect(report.capacity[report.capacity.length - 1]).toMatch(/^Confirmed: PLC-01 has the 1 AI, 2 DO and 1 DI/);
  });

  it("made the design the user asked for, and the pages report it valid", () => {
    expect(report.changes).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^Created the factory Tank farm/),
        expect.stringMatching(/^Created the compact PLC PLC-01 from .*Generic RTU/),
        expect.stringMatching(/^Added SENSOR-01 \(Generic level transmitter/),
        expect.stringMatching(/^Added VALVE-01 /),
        expect.stringMatching(/^Added PUMP-01 /),
        expect.stringMatching(/^Added MOTOR-01 /),
        expect.stringMatching(/^Added VFD-01 /),
        expect.stringMatching(/^Connected: VFD-01 drives MOTOR-01/),
        expect.stringMatching(/^Connected: MOTOR-01 mechanically drives PUMP-01/),
        expect.stringMatching(/^Wired .*SENSOR-01/),
        expect.stringMatching(/^Wired .*VALVE-01/),
        expect.stringMatching(/^Saved program version 1 of PLC-01/),
        expect.stringMatching(/^Created the process module TANK-01/),
        expect.stringMatching(/^Assigned SENSOR-01 as Level transmitter/),
        expect.stringMatching(/^Assigned VALVE-01 as Inlet valve/),
      ]),
    );
    expect(report.changes.filter((change) => change.startsWith("Wired "))).toHaveLength(4);
    // The design itself: every page that validates it says ok.
    const byPage = new Map(report.validation.map((entry) => [entry.page, entry]));
    for (const page of ["Designer", "Factory overview", "PLC I/O mapping"]) {
      const entry = byPage.get(page);
      expect(entry?.status, `${page}: ${entry?.items.join("; ")}`).toBe("ok");
    }
    expect(report.markdown).toContain("## Decisions asked");
  });

  it("reports what the pages could not do: the module's signals wait for program tags", () => {
    // Every tag of the PLC carries a wired device signal; a process signal needs a tag the
    // program drives (%M memory), and no page creates one yet. The agent reads that from the
    // picker's refusals and reports it instead of working around it.
    expect(report.blocked.map((entry) => entry.what)).toEqual([
      "Bind Level of TANK-01",
      "Bind Inlet valve open command of TANK-01",
    ]);
    for (const entry of report.blocked) {
      expect(entry.why.join(" ")).toMatch(/already carries a device signal/);
    }
    expect(report.asked.map((question) => question.label)).not.toContain("Which PLC tags carry the required signals?");
    const editor = report.validation.find((entry) => entry.page === "Process module");
    expect(editor?.status).toBe("issues");
    expect(editor?.items).toEqual(
      expect.arrayContaining([
        "Required signal Level is not bound",
        "Required signal Inlet valve open command is not bound",
      ]),
    );
    expect(report.markdown).toContain("## Not possible through the pages");
  });

  it("left a stored design the services validate the same way", async () => {
    const factory = await factoryRepository.findBySlug(db, OWNER, "tank-farm");
    expect(factory).not.toBeNull();
    const topology = await getTopology(db, { ownerId: OWNER }, factory!.id);
    expect(topology.nodes.map((node) => node.name).sort()).toEqual([
      "MOTOR-01",
      "PLC-01",
      "PUMP-01",
      "SENSOR-01",
      "VALVE-01",
      "VFD-01",
    ]);
    expect(topology.edges.map((edge) => edge.relationship).sort()).toEqual([
      "DRIVES",
      "MECHANICALLY_DRIVES",
      "WIRED_TO",
      "WIRED_TO",
      "WIRED_TO",
    ]);
    expect(
      topology.edges
        .flatMap((edge) => edge.wires)
        .map((wire) => wire.tagName)
        .sort(),
    ).toEqual(["SENSOR_01_OUT", "VALVE_01_Y1", "VFD_01_RUN", "VFD_01_RUNNING"]);
    const [summary] = await listModules(db, { ownerId: OWNER }, factory!.id);
    expect(summary?.name).toBe("TANK-01");
    const detail = await getModule(db, { ownerId: OWNER }, summary!.id);
    expect(detail.complete).toBe(true);
    expect(detail.issues).toEqual([]);
    // The roles are filled; the two required signals wait for program tags (see the report).
    expect(detail.bindings.requiredUnbound).toBe(2);
    expect(detail.bindings.invalid).toBe(0);
  });
});
