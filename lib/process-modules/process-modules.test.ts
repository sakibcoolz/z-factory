import { describe, expect, it } from "vitest";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { DomainError } from "@/lib/domain/errors";
import { countSignals, effectiveRoles, effectiveSignals } from "@/lib/domain/process-module";
import { loadModuleTypes } from "@/lib/process-modules";
import { type ModuleTypeInput, parseModuleType } from "@/lib/process-modules/schema";

const minimal: ModuleTypeInput = {
  code: "CELL",
  name: "Cell",
  roles: [{ key: "PUMP", name: "Pump", deviceCategoryCodes: ["PUMP"] }],
  signals: [{ key: "RUN_CMD", name: "Run", direction: "OUTPUT", dataType: "BOOL", role: "COMMAND", roleKey: "PUMP" }],
};

function refusal(input: unknown): DomainError {
  try {
    parseModuleType(input);
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe("VALIDATION");
    return error as DomainError;
  }
  throw new Error("expected the definition to be refused");
}

describe("module type definitions as data", () => {
  it("fills in what a definition leaves out", () => {
    const type = parseModuleType(minimal);
    expect(type).toMatchObject({ version: 1, profiles: [], configFields: [], simulatorModelType: null });
    expect(type.roles[0]).toMatchObject({ required: true, maxDevices: 1, profiles: [], description: null });
    expect(type.signals[0]).toMatchObject({ required: true, unit: null, rangeMin: null, profiles: [] });
  });

  it.each([
    ["a code that is no key", { ...minimal, code: "pump house" }],
    ["a type without signals", { ...minimal, signals: [] }],
    ["a field the format does not know", { ...minimal, heaterPower: 12 }],
    [
      "a device category that does not exist",
      { ...minimal, roles: [{ key: "PUMP", name: "Pump", deviceCategoryCodes: ["BOILER"] }] },
    ],
    ["a role that takes no device", { ...minimal, roles: [{ key: "PUMP", name: "Pump", maxDevices: 0 }] }],
  ])("refuses %s", (_name, input) => {
    refusal(input);
  });

  it("refuses what breaks the rules of a module type, naming it", () => {
    const error = refusal({
      ...minimal,
      signals: [{ key: "RUN_CMD", name: "Run", direction: "OUTPUT", dataType: "BOOL", role: "STATUS" }],
    });
    expect(error.message).toBe(
      "Invalid module type CELL: signal RUN_CMD: a OUTPUT signal cannot have the role STATUS.",
    );
  });
});

describe("the shipped module types", () => {
  const types = loadModuleTypes();
  const categories = new Set(GENERIC_CATEGORIES.map((category) => category.code));

  it("are valid and have unique versions", () => {
    const versions = types.map((type) => `${type.code}@${type.version}`);
    expect(new Set(versions).size).toBe(versions.length);
    expect(types.map((type) => type.code)).toEqual(expect.arrayContaining(["PUMP_HOUSE", "TANK"]));
  });

  it("declare signals of every direction, required and optional", () => {
    for (const type of types) {
      const counts = countSignals(type.signals);
      expect(counts.INPUT.required, type.code).toBeGreaterThan(0);
      expect(counts.OUTPUT.required, type.code).toBeGreaterThan(0);
      expect(counts.INPUT.optional + counts.OUTPUT.optional, type.code).toBeGreaterThan(0);
      expect(counts.INTERNAL.optional, type.code).toBeGreaterThan(0);
      expect(counts.ALARM.optional, type.code).toBeGreaterThan(0);
    }
  });

  it("name device categories only, never a manufacturer or a model", () => {
    for (const type of types) {
      for (const role of type.roles) {
        expect(role.deviceCategoryCodes.length, `${type.code}.${role.key}`).toBeGreaterThan(0);
        for (const code of role.deviceCategoryCodes) expect(categories.has(code), code).toBe(true);
      }
    }
  });

  it("give a profile its own number of roles and signals", () => {
    const pumpHouse = types.find((type) => type.code === "PUMP_HOUSE");
    if (!pumpHouse) throw new Error("PUMP_HOUSE is not shipped");
    const single = effectiveSignals(pumpHouse.signals, "SINGLE_PUMP");
    const standby = effectiveSignals(pumpHouse.signals, "DUTY_STANDBY");
    expect(standby.length).toBeGreaterThan(single.length);
    expect(single.some((signal) => signal.key.startsWith("STANDBY_"))).toBe(false);
    expect(effectiveRoles(pumpHouse.roles, "SINGLE_PUMP").map((role) => role.key)).not.toContain("STANDBY_PUMP");
    expect(effectiveRoles(pumpHouse.roles, "DUTY_STANDBY").map((role) => role.key)).toContain("STANDBY_PUMP");
  });

  it("have no process model yet", () => {
    // A model type is named once the process runtime exists (TASK-602).
    for (const type of types) expect(type.simulatorModelType).toBeNull();
  });
});
