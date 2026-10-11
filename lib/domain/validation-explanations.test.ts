import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLlmIndex } from "@/lib/agent/llm-index";
import { DomainError } from "./errors";
import {
  explainDomainError,
  explainRule,
  explanationLine,
  REFUSAL_KINDS,
  RULE_EXPLANATIONS,
} from "./validation-explanations";

/**
 * The files whose rules are engineering rules: an agent meets them while designing, and
 * every one has a full entry. Rules elsewhere (runtime, Docker, simulator, assets,
 * compiler) get a generic explanation from their code.
 */
const ENGINEERING_FILES = [
  "lib/validation/wiring.ts",
  "lib/services/wiring-service.ts",
  "lib/validation/connection.ts",
  "lib/validation/plc-architecture.ts",
  "lib/validation/tag.ts",
  "lib/validation/io-address.ts",
  "lib/validation/network.ts",
  "lib/validation/simulation.ts",
  "lib/domain/process-module.ts",
  "lib/domain/gateway.ts",
  "lib/services/plc-config-service.ts",
  "lib/services/tag-service.ts",
  "lib/services/topology-service.ts",
  "lib/services/module-io-service.ts",
  "lib/services/process-module-service.ts",
  "lib/services/gateway-service.ts",
  "lib/services/factory-service.ts",
  "lib/services/plc-communication-service.ts",
  "lib/services/device-detail-service.ts",
  "lib/services/edge-deployment-service.ts",
  "lib/services/plc-export-service.ts",
  "lib/services/catalog-service.ts",
  "lib/services/demo-service.ts",
  "lib/protocols/modbus/located-address.ts",
  "lib/process-modules/ingest.ts",
];

/** `rule: "x"`, `refusal("x"` and `"wire-x" as const`: the forms a rule name takes in the code. */
const RULE = /(?:rule:\s*|refusal\(\s*)"([a-z0-9-]+)"|"(wire-[a-z0-9-]+)" as const/g;

function rulesIn(file: string): string[] {
  return [...readFileSync(file, "utf8").matchAll(RULE)].map((match) => (match[1] ?? match[2])!);
}

function sourceFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry !== "generated") files.push(...sourceFiles(path));
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) files.push(path);
  }
  return files;
}

describe("the rule explanations", () => {
  it("cover every engineering rule the code raises", () => {
    const missing = ENGINEERING_FILES.flatMap((file) =>
      rulesIn(file)
        .filter((rule) => !RULE_EXPLANATIONS[rule])
        .map((rule) => `${file}: ${rule}`),
    );
    expect(missing).toEqual([]);
  });

  it("name only rules that exist, kinds that exist and areas of the LLM Index", () => {
    const raised = new Set(sourceFiles("lib").flatMap(rulesIn));
    const areas = buildLlmIndex().areas.map((area) => area.key);
    for (const [rule, entry] of Object.entries(RULE_EXPLANATIONS)) {
      expect(raised.has(rule), `${rule} is raised somewhere`).toBe(true);
      expect(Object.keys(REFUSAL_KINDS)).toContain(entry.kind);
      expect(areas, `${rule} → ${entry.area}`).toContain(entry.area);
      expect(entry.expected.length).toBeGreaterThan(10);
      expect(entry.remediation.length).toBeGreaterThan(10);
    }
  });
});

describe("explaining a domain error", () => {
  it("uses the rule's entry, and reads the field, the object and the facts from the details", () => {
    const error = new DomainError(
      "INCOMPATIBLE",
      "Signal type ANALOG_4_20MA is not accepted by this channel (DIGITAL_24V).",
      {
        rule: "signal-type",
        required: "ANALOG_4_20MA",
        actual: ["DIGITAL_24V"],
        terminal: "OUT",
      },
    );
    expect(explainDomainError(error)).toEqual({
      code: "INCOMPATIBLE",
      rule: "signal-type",
      kind: "fixable",
      expected: RULE_EXPLANATIONS["signal-type"]!.expected,
      actual: error.message,
      remediation: RULE_EXPLANATIONS["signal-type"]!.remediation,
      area: "designer",
      field: undefined,
      object: "OUT",
      destination: undefined,
      facts: { required: "ANALOG_4_20MA", actual: "DIGITAL_24V", terminal: "OUT" },
    });
    expect(
      explainDomainError(
        new DomainError("CONFLICT", "overlaps", {
          rule: "address-overlap",
          conflictsWith: "VFD_01_RUN",
          field: "address",
        }),
      ),
    ).toMatchObject({
      kind: "fixable",
      destination: "VFD_01_RUN",
      field: "address",
    });
  });

  it("falls back to the code for a rule it does not know, with an area from the rule's family", () => {
    expect(
      explainDomainError(
        new DomainError("RUNTIME_FAILURE", "The Docker Engine is not reachable.", { rule: "docker-unreachable" }),
      ),
    ).toMatchObject({
      kind: "unavailable",
      expected: undefined,
      area: "runtime",
      remediation: expect.stringContaining("Runtime page"),
    });
    expect(
      explainDomainError(
        new DomainError("CONFLICT", "The simulation is already running.", { rule: "simulation-running" }),
      ),
    ).toMatchObject({ kind: "state", area: "simulation" });
    expect(
      explainDomainError(
        new DomainError("INVARIANT", "Refusing to touch an unmanaged container.", { rule: "managed-only" }),
      ),
    ).toMatchObject({ kind: "unsupported", area: "runtime" });
    expect(explainDomainError(new DomainError("NOT_FOUND", "The factory does not exist."))).toMatchObject({
      rule: null,
      kind: "fixable",
      area: undefined,
    });
    expect(
      explainDomainError(new DomainError("UNAUTHORIZED", "No owner is configured.", { rule: "owner-required" })),
    ).toMatchObject({ kind: "unsupported" });
  });

  it("explains a rule met in stored state, and writes a one-line form of it", () => {
    const explanation = explainRule("module-role-empty", "The role Level sensor has no device.", {
      object: "Tank T-01",
      destination: "level",
    });
    expect(explanation).toMatchObject({
      code: "VALIDATION",
      rule: "module-role-empty",
      kind: "fixable",
      object: "Tank T-01",
      destination: "level",
    });
    const known = explainRule("tag-mapped", "This tag already carries Level of Tank T-01.");
    expect(known).toMatchObject({
      kind: "fixable",
      area: "modules",
      expected: RULE_EXPLANATIONS["tag-mapped"]!.expected,
    });
    expect(explanationLine(known)).toBe(
      `rule tag-mapped · fixable · expected: ${RULE_EXPLANATIONS["tag-mapped"]!.expected} · do: ${RULE_EXPLANATIONS["tag-mapped"]!.remediation}`,
    );
    expect(explanationLine(explainDomainError(new DomainError("NOT_FOUND", "gone")))).toBe(
      "code NOT_FOUND · fixable · do: Open the object from its own page; it may belong to another factory or no longer exist.",
    );
  });
});
