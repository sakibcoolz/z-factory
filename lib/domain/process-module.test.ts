import { describe, expect, it } from "vitest";
import { DomainError } from "./errors";
import {
  appliesToProfile,
  checkInterlock,
  checkModuleType,
  countSignals,
  effectiveRoles,
  effectiveSignals,
  type ModuleConfigField,
  moduleIssues,
  type ModuleRole,
  type ModuleSignal,
  type ModuleTypeDefinition,
  resolveModuleConfig,
  resolveProfile,
  roleAcceptsCategory,
  signalRoleFits,
} from "./process-module";

const role = (key: string, overrides: Partial<ModuleRole> = {}): ModuleRole => ({
  key,
  name: key.toLowerCase(),
  description: null,
  deviceCategoryCodes: [],
  required: true,
  maxDevices: 1,
  profiles: [],
  ...overrides,
});

const signal = (key: string, overrides: Partial<ModuleSignal> = {}): ModuleSignal => ({
  key,
  name: key.toLowerCase(),
  description: null,
  direction: "INPUT",
  dataType: "BOOL",
  role: "STATUS",
  unit: null,
  signalType: null,
  required: true,
  rangeMin: null,
  rangeMax: null,
  roleKey: null,
  profiles: [],
  ...overrides,
});

const field = (key: string, overrides: Partial<ModuleConfigField> = {}): ModuleConfigField => ({
  key,
  label: key,
  type: "number",
  unit: null,
  min: null,
  max: null,
  options: [],
  defaultValue: null,
  ...overrides,
});

const type = (overrides: Partial<ModuleTypeDefinition> = {}): ModuleTypeDefinition => ({
  code: "CELL",
  name: "Cell",
  version: 1,
  description: null,
  simulatorModelType: null,
  profiles: ["BASIC", "FULL"],
  configFields: [],
  roles: [role("PUMP", { deviceCategoryCodes: ["PUMP"] }), role("SPARE", { profiles: ["FULL"] })],
  signals: [
    signal("RUN_CMD", { direction: "OUTPUT", role: "COMMAND", roleKey: "PUMP" }),
    signal("RUNNING", { role: "FEEDBACK", roleKey: "PUMP" }),
    signal("SPARE_RUNNING", { role: "FEEDBACK", roleKey: "SPARE", profiles: ["FULL"] }),
    signal("PRESSURE", { dataType: "FLOAT32", role: "PROCESS_VALUE", unit: "bar", rangeMin: 0, rangeMax: 16 }),
    signal("FLOW", { direction: "INTERNAL", dataType: "FLOAT32", role: "PROCESS_VALUE", required: false }),
    signal("TRIP", { direction: "ALARM", role: "ALARM", required: false }),
  ],
  ...overrides,
});

function refusal(action: () => unknown): DomainError {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    return error as DomainError;
  }
  throw new Error("expected a refusal");
}

describe("signal directions and roles", () => {
  it("makes an output a command or a setpoint, and nothing else one", () => {
    expect(signalRoleFits("OUTPUT", "COMMAND")).toBe(true);
    expect(signalRoleFits("OUTPUT", "SETPOINT")).toBe(true);
    expect(signalRoleFits("OUTPUT", "FEEDBACK")).toBe(false);
    for (const direction of ["INPUT", "INTERNAL", "ALARM"] as const) {
      expect(signalRoleFits(direction, "COMMAND")).toBe(false);
      expect(signalRoleFits(direction, "SETPOINT")).toBe(false);
    }
  });

  it("lets an input or an internal value be feedback, status, an alarm or a process value", () => {
    for (const tagRole of ["FEEDBACK", "STATUS", "ALARM", "PROCESS_VALUE"] as const) {
      expect(signalRoleFits("INPUT", tagRole)).toBe(true);
      expect(signalRoleFits("INTERNAL", tagRole)).toBe(true);
    }
  });

  it("keeps an alarm point an alarm or a status", () => {
    expect(signalRoleFits("ALARM", "ALARM")).toBe(true);
    expect(signalRoleFits("ALARM", "STATUS")).toBe(true);
    expect(signalRoleFits("ALARM", "PROCESS_VALUE")).toBe(false);
  });
});

describe("profiles", () => {
  it("puts a role or signal without profiles into every profile", () => {
    expect(appliesToProfile({ profiles: [] }, "BASIC")).toBe(true);
    expect(appliesToProfile({ profiles: [] }, null)).toBe(true);
    expect(appliesToProfile({ profiles: ["FULL"] }, "FULL")).toBe(true);
    expect(appliesToProfile({ profiles: ["FULL"] }, "BASIC")).toBe(false);
    expect(appliesToProfile({ profiles: ["FULL"] }, null)).toBe(false);
  });

  it("gives a module the I/O count of its profile, not one count for the type", () => {
    const { roles, signals } = type();
    expect(effectiveRoles(roles, "BASIC").map((item) => item.key)).toEqual(["PUMP"]);
    expect(effectiveRoles(roles, "FULL").map((item) => item.key)).toEqual(["PUMP", "SPARE"]);
    expect(countSignals(effectiveSignals(signals, "BASIC"))).toEqual({
      INPUT: { required: 2, optional: 0 },
      OUTPUT: { required: 1, optional: 0 },
      INTERNAL: { required: 0, optional: 1 },
      ALARM: { required: 0, optional: 1 },
    });
    expect(countSignals(effectiveSignals(signals, "FULL")).INPUT).toEqual({ required: 3, optional: 0 });
  });

  it("selects the first profile when none is asked for and refuses an unknown one", () => {
    expect(resolveProfile({ profiles: ["BASIC", "FULL"] }, undefined)).toBe("BASIC");
    expect(resolveProfile({ profiles: ["BASIC", "FULL"] }, "FULL")).toBe("FULL");
    expect(refusal(() => resolveProfile({ profiles: ["BASIC"] }, "OTHER")).details.rule).toBe("module-profile");
    expect(resolveProfile({ profiles: [] }, undefined)).toBeNull();
    expect(refusal(() => resolveProfile({ profiles: [] }, "BASIC")).code).toBe("VALIDATION");
  });
});

describe("module type definitions", () => {
  it("accepts a sound definition", () => {
    expect(checkModuleType(type())).toEqual([]);
  });

  it.each<[string, Partial<ModuleTypeDefinition>, string]>([
    ["a profile listed twice", { profiles: ["BASIC", "BASIC", "FULL"] }, "profile BASIC is listed twice"],
    ["a role defined twice", { roles: [role("PUMP"), role("PUMP"), role("SPARE")] }, "role PUMP is defined twice"],
    ["a signal defined twice", { signals: [signal("RUNNING"), signal("RUNNING")] }, "signal RUNNING is defined twice"],
    [
      "a role in an unknown profile",
      { roles: [role("PUMP", { profiles: ["HUGE"] })], signals: [signal("X")] },
      "role PUMP names unknown profile HUGE",
    ],
    [
      "a signal in an unknown profile",
      { signals: [signal("X", { profiles: ["HUGE"] })] },
      "signal X names unknown profile HUGE",
    ],
    [
      "an output that is not a command",
      { signals: [signal("X", { direction: "OUTPUT", role: "FEEDBACK" })] },
      "signal X: a OUTPUT signal cannot have the role FEEDBACK",
    ],
    [
      "an input that is a command",
      { signals: [signal("X", { direction: "INPUT", role: "COMMAND" })] },
      "signal X: a INPUT signal cannot have the role COMMAND",
    ],
    [
      "a range that runs backwards",
      { signals: [signal("X", { dataType: "FLOAT32", role: "PROCESS_VALUE", rangeMin: 5, rangeMax: 5 })] },
      "signal X: the range must run from a lower to a higher value",
    ],
    [
      "a BOOL with a unit",
      { signals: [signal("X", { unit: "bar" })] },
      "signal X: a BOOL signal has no range and no unit",
    ],
    [
      "a signal on a role that does not exist",
      { signals: [signal("X", { roleKey: "GHOST" })] },
      "signal X belongs to unknown role GHOST",
    ],
    [
      "a signal in a profile its role is not in",
      { signals: [signal("X", { roleKey: "SPARE" })] },
      "signal X applies to BASIC, where its role SPARE does not exist",
    ],
    [
      "a required signal on an optional role",
      { roles: [role("PUMP", { required: false })], signals: [signal("X", { roleKey: "PUMP" })] },
      "signal X is required but its role PUMP is optional",
    ],
    [
      "a choice without options",
      { configFields: [field("mode", { type: "choice" })] },
      "configuration field mode offers no option",
    ],
    [
      "a default outside the limits",
      { configFields: [field("volume", { min: 1, defaultValue: 0 })] },
      "configuration field volume: the default must be at least 1",
    ],
    [
      "limits on text",
      { configFields: [field("label", { type: "text", max: 3 })] },
      "configuration field label: only a number has limits and a unit",
    ],
  ])("refuses %s", (_name, overrides, message) => {
    expect(checkModuleType(type(overrides))).toContain(message);
  });
});

describe("module configuration", () => {
  const fields = [
    field("volume", { min: 0.01, max: 500, defaultValue: 10 }),
    field("stages", { type: "integer", min: 1, max: 4 }),
    field("mode", { type: "choice", options: ["BATCH", "CONTINUOUS"], defaultValue: "BATCH" }),
    field("insulated", { type: "boolean", defaultValue: false }),
  ];

  it("fills in the defaults of the type", () => {
    expect(resolveModuleConfig(fields, { stages: 2 })).toEqual({
      volume: 10,
      stages: 2,
      mode: "BATCH",
      insulated: false,
    });
  });

  it.each([
    ["a setting the type does not declare", { stages: 1, heaterPower: 12 }, "heaterPower"],
    ["a field without a default left out", {}, "stages"],
    ["a value below the limit", { stages: 0 }, "stages"],
    ["a fraction for a whole number", { stages: 1.5 }, "stages"],
    ["a value above the limit", { stages: 1, volume: 501 }, "volume"],
    ["text for a number", { stages: 1, volume: "big" }, "volume"],
    ["an option the type does not offer", { stages: 1, mode: "FED_BATCH" }, "mode"],
    ["a number for a switch", { stages: 1, insulated: 1 }, "insulated"],
  ])("refuses %s", (_name, input, fieldKey) => {
    const error = refusal(() => resolveModuleConfig(fields, input));
    expect(error.code).toBe("VALIDATION");
    expect(error.details).toMatchObject({ rule: "module-config", field: fieldKey });
  });
});

describe("device roles", () => {
  it("accepts the categories a role names, and any when it names none", () => {
    expect(roleAcceptsCategory({ deviceCategoryCodes: ["PUMP"] }, "PUMP")).toBe(true);
    expect(roleAcceptsCategory({ deviceCategoryCodes: ["PUMP"] }, "VALVE")).toBe(false);
    expect(roleAcceptsCategory({ deviceCategoryCodes: [] }, "VALVE")).toBe(true);
  });
});

describe("interlocks", () => {
  const signals = type().signals;

  it("accepts conditions that read each signal as what it is, blocking outputs", () => {
    expect(
      checkInterlock(
        {
          when: [
            { signal: "PRESSURE", operator: "GT", value: 12 },
            { signal: "RUNNING", operator: "IS_TRUE" },
          ],
          blocks: ["RUN_CMD"],
        },
        signals,
      ),
    ).toEqual([]);
  });

  it.each([
    [
      "a signal the module does not have",
      { when: [{ signal: "LEVEL", operator: "IS_TRUE" }], blocks: ["RUN_CMD"] },
      "signal LEVEL is not part of this module",
    ],
    [
      "a BOOL compared with a value",
      { when: [{ signal: "RUNNING", operator: "GT", value: 1 }], blocks: ["RUN_CMD"] },
      "RUNNING is a BOOL: use IS_TRUE or IS_FALSE without a value",
    ],
    [
      "a number read as true",
      { when: [{ signal: "PRESSURE", operator: "IS_TRUE" }], blocks: ["RUN_CMD"] },
      "PRESSURE is a number: compare it with a value",
    ],
    [
      "a number compared with nothing",
      { when: [{ signal: "PRESSURE", operator: "GT" }], blocks: ["RUN_CMD"] },
      "PRESSURE is a number: compare it with a value",
    ],
    [
      "a limit outside the signal's range",
      { when: [{ signal: "PRESSURE", operator: "GT", value: 40 }], blocks: ["RUN_CMD"] },
      "PRESSURE: 40 is outside its range 0 to 16",
    ],
    [
      "blocking something that is not an output",
      { when: [{ signal: "RUNNING", operator: "IS_FALSE" }], blocks: ["PRESSURE"] },
      "PRESSURE is not an output: an interlock blocks outputs",
    ],
    [
      "blocking an output twice",
      { when: [{ signal: "RUNNING", operator: "IS_FALSE" }], blocks: ["RUN_CMD", "RUN_CMD"] },
      "output RUN_CMD is listed twice",
    ],
  ] as const)("refuses %s", (_name, expression, message) => {
    expect(checkInterlock({ when: [...expression.when], blocks: [...expression.blocks] }, signals)).toContain(message);
  });
});

describe("issues of a stored module", () => {
  const { roles, signals } = type();
  const base = { profile: "BASIC", roles, signals, assignments: [], interlocks: [] };
  const pump = { roleKey: "PUMP", deviceName: "P-101", categoryCode: "PUMP" };

  it("reports a required role without a device, and nothing once it is filled", () => {
    expect(moduleIssues(base)).toEqual([
      { rule: "module-role-empty", subject: "PUMP", message: "pump has no device." },
    ]);
    expect(moduleIssues({ ...base, assignments: [pump] })).toEqual([]);
  });

  it("asks for the roles of the selected profile only", () => {
    expect(moduleIssues({ ...base, profile: "FULL", assignments: [pump] }).map((issue) => issue.subject)).toEqual([
      "SPARE",
    ]);
  });

  it("reports a role with more devices than it takes", () => {
    const issues = moduleIssues({ ...base, assignments: [pump, { ...pump, deviceName: "P-102" }] });
    expect(issues).toEqual([{ rule: "module-role-full", subject: "PUMP", message: "pump has 2 devices; it takes 1." }]);
  });

  it("reports a device whose category its role no longer accepts", () => {
    const issues = moduleIssues({ ...base, assignments: [{ ...pump, categoryCode: "VALVE" }] });
    expect(issues.map((issue) => issue.rule)).toEqual(["module-role-category"]);
  });

  it("reports a device in a role the profile does not have", () => {
    const spare = { roleKey: "SPARE", deviceName: "P-201", categoryCode: "PUMP" };
    expect(moduleIssues({ ...base, assignments: [pump, spare] }).map((issue) => issue.rule)).toEqual([
      "module-role-profile",
    ]);
  });

  it("reports an enabled interlock that no longer fits, and leaves a disabled one alone", () => {
    const expression = { when: [{ signal: "SPARE_RUNNING", operator: "IS_FALSE" as const }], blocks: ["RUN_CMD"] };
    const interlock = { code: "SPARE_DOWN", enabled: true, expression };
    expect(moduleIssues({ ...base, assignments: [pump], interlocks: [interlock] })).toEqual([
      {
        rule: "module-interlock",
        subject: "SPARE_DOWN",
        message: "SPARE_DOWN: signal SPARE_RUNNING is not part of this module.",
      },
    ]);
    expect(moduleIssues({ ...base, assignments: [pump], interlocks: [{ ...interlock, enabled: false }] })).toEqual([]);
  });
});
