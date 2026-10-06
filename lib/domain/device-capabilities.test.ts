import { describe, expect, it } from "vitest";
import {
  controllerKind,
  deviceSections,
  isProgrammableController,
  type ModelCapabilities,
  programSupport,
} from "./device-capabilities";

const model = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  categoryCode: "VFD",
  capabilities: [],
  runtimeSupport: "DEVICE_SIM",
  architectureType: null,
  simulatorType: "VFD",
  hasPorts: false,
  ...overrides,
});

const plc = model({
  categoryCode: "PLC",
  capabilities: ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER"],
  runtimeSupport: "OPENPLC",
  architectureType: "COMPACT",
  simulatorType: "NONE",
  hasPorts: true,
});

describe("screens from capabilities", () => {
  it("gives a PLC the program, versions, hardware, mapping, runtime and export screens", () => {
    expect(deviceSections(plc)).toEqual([
      "overview",
      "hardware",
      "connections",
      "program",
      "io-mapping",
      "versions",
      "runtime",
      "export",
    ]);
  });

  it("treats a programmable RTU on the OpenPLC adapter exactly like a PLC", () => {
    const rtu = { ...plc, categoryCode: "RTU", capabilities: [...plc.capabilities, "REMOTE_CONTROL" as const] };
    expect(deviceSections(rtu)).toEqual(deviceSections(plc));
    expect(isProgrammableController(rtu)).toBe(true);
    expect(controllerKind(rtu)).toBe("RTU · compact");
    expect(controllerKind(plc)).toBe("PLC · compact");
  });

  it("gives a hardwired drive parameters and a runtime, and no program", () => {
    expect(deviceSections(model({ capabilities: ["PARAMETER_CONFIGURABLE", "LOCAL_CONTROL"] }))).toEqual([
      "overview",
      "connections",
      "parameters",
      "runtime",
    ]);
  });

  it("gives a Modbus drive registers and communications instead of a program editor", () => {
    const drive = model({
      capabilities: ["PARAMETER_CONFIGURABLE", "REMOTE_CONTROL", "MODBUS_SERVER"],
      runtimeSupport: "NONE",
      hasPorts: true,
    });
    expect(deviceSections(drive)).toEqual([
      "overview",
      "connections",
      "parameters",
      "registers",
      "communications",
      "runtime",
    ]);
    expect(deviceSections(drive)).not.toContain("program");
  });

  it("never shows a program screen because of the category alone", () => {
    // A controller category without the capability is no controller, and a VFD never gets one.
    const bare = model({ categoryCode: "RTU", simulatorType: "NONE" });
    expect(deviceSections(bare)).toEqual(["overview", "connections"]);
    expect(isProgrammableController(bare)).toBe(false);
    expect(controllerKind(bare)).toBeNull();
    expect(deviceSections(model({ categoryCode: "VFD" }))).not.toContain("program");
  });

  it("gives a sensor and a power supply only what they have", () => {
    expect(deviceSections(model({ categoryCode: "SENSOR", simulatorType: "SENSOR" }))).toEqual([
      "overview",
      "connections",
      "runtime",
    ]);
    expect(
      deviceSections(model({ categoryCode: "POWER_SUPPLY", simulatorType: "NONE", runtimeSupport: "NONE" })),
    ).toEqual(["overview", "connections"]);
  });
});

describe("program support", () => {
  it("runs the program workflow for an IEC 61131-3 model on the OpenPLC adapter only", () => {
    expect(programSupport(plc)).toEqual({ supported: true, language: "ST", adapter: "OPENPLC" });
    expect(programSupport(model())).toMatchObject({ supported: false, reason: "This model runs no user program." });
    expect(programSupport({ capabilities: ["PROGRAMMABLE", "SCRIPTABLE"], runtimeSupport: "NONE" })).toMatchObject({
      supported: false,
      reason: expect.stringContaining("not programmed in an IEC 61131-3 language"),
    });
    expect(programSupport({ capabilities: ["PROGRAMMABLE", "IEC_61131_3"], runtimeSupport: "NONE" })).toMatchObject({
      supported: false,
      reason: "No runtime adapter runs programs for this model yet.",
    });
  });
});
