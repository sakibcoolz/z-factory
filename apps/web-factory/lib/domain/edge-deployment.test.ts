import { describe, expect, it } from "vitest";
import { deploymentDocumentSchema, deploymentProblems } from "@/lib/domain/edge-deployment";
import { deploymentFile, mapping } from "@/test/harness";

const parse = (text: string) => deploymentDocumentSchema.parse(JSON.parse(text));

describe("the edge deployment contract", () => {
  it("reads a file as Z-Factory exports it", () => {
    const document = parse(deploymentFile());
    expect(document.deployment.mappings.map((m) => [m.name, m.access])).toEqual([
      ["Start_Cmd", "WRITE"],
      ["Speed_SP", "WRITE"],
      ["Running", "READ"],
    ]);
    expect(deploymentProblems(document)).toEqual([]);
  });

  it("refuses a writable tag the PLC program owns, and duplicates", () => {
    const writableOutput = parse(
      deploymentFile({
        mappings: [mapping("t-run", "Running", "WRITE", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 8192)],
      }),
    );
    expect(deploymentProblems(writableOutput).map((p) => p.rule)).toEqual(["mapping-write"]);
    const inputCommand = parse(
      deploymentFile({
        mappings: [mapping("t-x", "X", "WRITE", "COMMAND", "EXTERNAL_COMMAND", "BOOL", "DISCRETE_INPUT", 0)],
      }),
    );
    expect(deploymentProblems(inputCommand).map((p) => p.rule)).toEqual(["mapping-write"]);
    const twice = parse(
      deploymentFile({
        mappings: [
          mapping("t-a", "A", "READ", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 0),
          mapping("t-a", "B", "READ", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 1),
        ],
      }),
    );
    expect(deploymentProblems(twice).map((p) => p.rule)).toEqual(["mapping-duplicate"]);
    expect(() => parse(deploymentFile().replace('"schemaVersion": 1', '"schemaVersion": 2'))).toThrow();
  });
});
