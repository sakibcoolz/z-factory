import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import { eventDetail, type LocatedVariableView } from "@/lib/domain/plc-runtime-view";
import { toOperationState } from "./operation-state";
import { iecTypeFor, isIecIdentifier, programNameFor, starterProgram } from "./program-template";

const variable = (overrides: Partial<LocatedVariableView>): LocatedVariableView => ({
  name: "XV_101_Y1",
  address: "%QX0.0",
  type: "BOOL",
  source: null,
  ...overrides,
});

describe("starter program", () => {
  it("declares every tag as a located variable and names the program after the PLC", () => {
    const source = starterProgram("PLC-01", [
      variable({ source: "XV-101 · open" }),
      variable({ name: "PT_101_OUT", address: "%MW0", type: "INT" }),
    ]);
    expect(source).toContain("PROGRAM plc_01");
    expect(source).toContain("XV_101_Y1  AT %QX0.0 : BOOL; (* XV-101 · open *)");
    expect(source).toContain("PT_101_OUT AT %MW0 : INT;");
    expect(source).toContain("PROGRAM instance0 WITH task0 : plc_01;");
    expect(source.endsWith("END_CONFIGURATION\n")).toBe(true);
  });

  it("leaves out names a program cannot declare", () => {
    const source = starterProgram("PLC-01", [
      variable({ name: "has space" }),
      variable({ name: "9lives" }),
      variable({ name: "double__underscore" }),
      variable({ name: "trailing_" }),
      // IEC identifiers are case-insensitive: this would clash with the starter's own counter.
      variable({ name: "SCANS" }),
      variable({ name: "Good_1" }),
    ]);
    const declared = source.split("\n").filter((line) => line.includes(" AT "));
    expect(declared).toEqual(["    Good_1 AT %QX0.0 : BOOL;"]);
  });

  it("is a complete program for a PLC without tags", () => {
    const source = starterProgram("PLC-01", []);
    expect(source).not.toContain(" AT ");
    expect(source).toContain("Scans := Scans + 1;");
  });

  it("derives a valid program name from any device name", () => {
    expect(programNameFor("S7-1200 / Line 2")).toBe("s7_1200_line_2");
    expect(programNameFor("1214C")).toBe("p_1214c");
    expect(programNameFor("---")).toBe("main");
    for (const name of ["PLC-01", "1214C", "---", "Ünïcode PLC"]) {
      expect(isIecIdentifier(programNameFor(name))).toBe(true);
    }
  });

  it("maps tag data types to IEC elementary types", () => {
    expect(
      (["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT32"] as const).map((dataType) => iecTypeFor(dataType)),
    ).toEqual(["BOOL", "INT", "UINT", "DINT", "UDINT", "REAL"]);
  });
});

describe("operation state", () => {
  it("passes a domain message and well-formed compiler findings to the page", () => {
    const state = toOperationState(
      new DomainError("VALIDATION", "The program does not compile.", {
        rule: "program-compile",
        diagnostics: [
          { message: "Unexpected `;`", line: 3, column: 10, severity: "error" },
          { message: "no position" },
          "not a diagnostic",
        ],
      }),
    );
    expect(state).toEqual({
      message: "The program does not compile.",
      diagnostics: [{ message: "Unexpected `;`", line: 3, column: 10, severity: "error" }],
    });
  });

  it("keeps server detail of a runtime failure away from the page", () => {
    const state = toOperationState(
      new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime could not build the program.", {
        rule: "runtime-build-failed",
        log: ["ERROR /workdir/core/generated/plc.cpp:12"],
      }),
    );
    expect(state).toEqual({ message: "The OpenPLC runtime could not build the program." });
  });

  it("replaces anything that is not a domain error by a generic message", () => {
    const state = toOperationState(new Error("connect ENOENT /var/run/docker.sock"));
    expect(state).toEqual({ message: "Something went wrong. Try again." });
    expect(JSON.stringify(state)).not.toContain("docker.sock");
  });
});

describe("runtime event detail", () => {
  it("shows the known payload keys in a fixed order", () => {
    expect(eventDetail({ rule: "runtime-start-timeout", code: "RUNTIME_FAILURE", action: "start" })).toBe(
      "action start · code RUNTIME_FAILURE · rule runtime-start-timeout",
    );
    expect(eventDetail({ version: 3, warnings: 0 })).toBe("version 3 · warnings 0");
  });

  it("ignores unknown keys, nested values and non-objects", () => {
    expect(eventDetail({ log: ["/workdir/x"], containerId: "abc", state: { nested: true }, plcStatus: null })).toBe("");
    expect(eventDetail(null)).toBe("");
    expect(eventDetail(["action"])).toBe("");
    expect(eventDetail("action")).toBe("");
  });
});
