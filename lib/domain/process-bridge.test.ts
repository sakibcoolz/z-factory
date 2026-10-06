import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  checkProcessMapping,
  checkProcessMappings,
  fromModelValue,
  locatedRegion,
  type ProcessSignalTag,
  processFlow,
  tagEngineeringRange,
  toModelValue,
} from "@/lib/domain/process-bridge";
import type { ModuleSignal } from "@/lib/domain/process-module";

const signal = (
  overrides: Partial<ModuleSignal> & Pick<ModuleSignal, "key" | "direction" | "dataType">,
): ModuleSignal => ({
  name: overrides.key,
  description: null,
  role: overrides.direction === "OUTPUT" ? "COMMAND" : overrides.direction === "ALARM" ? "ALARM" : "FEEDBACK",
  unit: null,
  signalType: null,
  required: true,
  rangeMin: null,
  rangeMax: null,
  roleKey: null,
  profiles: [],
  ...overrides,
});

let tagCount = 0;
const tag = (logicalAddress: string, overrides: Partial<ProcessSignalTag> = {}): ProcessSignalTag => {
  const region = logicalAddress[1] ?? "M";
  const size = logicalAddress[2] ?? "W";
  const [byte = 0, bit = 0] = logicalAddress.slice(3).split(".").map(Number);
  const bitAddress = byte * 8 + bit + (region === "M" ? 8192 : 0);
  const wordAddress = size === "D" ? 2048 + byte * 2 : (region === "M" ? 1024 : 0) + byte;
  tagCount += 1;
  return {
    id: `tag-${tagCount}`,
    plcId: "plc-1",
    name: `T${tagCount}`,
    dataType: size === "X" ? "BOOL" : size === "D" ? "FLOAT32" : "INT16",
    role: "FEEDBACK",
    accessMode: "READ_ONLY",
    logicalAddress,
    protocolArea:
      size === "X"
        ? region === "I"
          ? "DISCRETE_INPUT"
          : "COIL"
        : region === "I"
          ? "INPUT_REGISTER"
          : "HOLDING_REGISTER",
    protocolAddress: size === "X" ? bitAddress : wordAddress,
    wordCount: size === "D" ? 2 : 1,
    byteOrder: "BIG_ENDIAN",
    wordOrder: "HIGH_WORD_FIRST",
    scale: 1,
    offset: 0,
    unit: null,
    sourceDeviceInstanceId: null,
    ...overrides,
  };
};

const RUN_CMD = signal({ key: "DUTY_RUN_CMD", direction: "OUTPUT", dataType: "BOOL" });
const SPEED_SP = signal({
  key: "DUTY_SPEED_SETPOINT",
  direction: "OUTPUT",
  dataType: "FLOAT32",
  role: "SETPOINT",
  unit: "%",
  rangeMin: 0,
  rangeMax: 100,
});
const RUNNING = signal({ key: "DUTY_RUNNING", direction: "INPUT", dataType: "BOOL" });
const PRESSURE = signal({
  key: "DISCHARGE_PRESSURE",
  direction: "INPUT",
  dataType: "FLOAT32",
  role: "PROCESS_VALUE",
  unit: "bar",
  rangeMin: 0,
});
const FLOW = signal({
  key: "FLOW",
  direction: "INTERNAL",
  dataType: "FLOAT32",
  role: "PROCESS_VALUE",
  required: false,
});
const LOW_PRESSURE = signal({ key: "LOW_PRESSURE", direction: "ALARM", dataType: "BOOL", required: false });

const rule = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.details.rule;
    throw error;
  }
  return undefined;
};

describe("process bridge: one signal on one tag", () => {
  it("carries a command from a %Q or %M address into the process and feedback to %M only", () => {
    expect(checkProcessMapping(RUN_CMD, tag("%QX0.0"))).toBe("INTO_PROCESS");
    expect(checkProcessMapping(RUN_CMD, tag("%MX0.0"))).toBe("INTO_PROCESS");
    expect(rule(() => checkProcessMapping(RUN_CMD, tag("%IX0.0")))).toBe("signal-address");
    expect(checkProcessMapping(RUNNING, tag("%MX1.0"))).toBe("TO_PLC");
    expect(checkProcessMapping(LOW_PRESSURE, tag("%MX1.1"))).toBe("TO_PLC");
    expect(rule(() => checkProcessMapping(RUNNING, tag("%QX1.0")))).toBe("signal-address");
    expect(rule(() => checkProcessMapping(RUNNING, tag("%IX1.0")))).toBe("signal-address");
    expect(rule(() => checkProcessMapping(RUNNING, tag("%MX1.0", { logicalAddress: null })))).toBe("signal-address");
  });

  it("never carries an internal value and never touches a tag a gateway may write", () => {
    expect(rule(() => checkProcessMapping(FLOW, tag("%MD0")))).toBe("module-signal-direction");
    // A COMMAND tag a gateway writes would let it bypass the program; the program drives the process.
    expect(rule(() => checkProcessMapping(RUN_CMD, tag("%QX0.0", { role: "COMMAND", accessMode: "READ_WRITE" })))).toBe(
      "signal-plc-driven",
    );
    expect(rule(() => checkProcessMapping(RUNNING, tag("%MX1.0", { sourceDeviceInstanceId: "dev-1" })))).toBe(
      "tag-in-use",
    );
    expect(rule(() => checkProcessMapping(RUNNING, tag("%MX1.0", { protocolArea: null, protocolAddress: null })))).toBe(
      "modbus-mapping",
    );
  });

  it("matches on/off with BOOL and numbers with register tags, whatever the width", () => {
    expect(rule(() => checkProcessMapping(RUN_CMD, tag("%QW0")))).toBe("signal-data-type");
    expect(rule(() => checkProcessMapping(PRESSURE, tag("%MX0.0")))).toBe("signal-data-type");
    expect(checkProcessMapping(PRESSURE, tag("%MD0"))).toBe("TO_PLC");
    // A FLOAT32 process value fits a scaled INT16 register: the codec scales it on the way.
    expect(checkProcessMapping(PRESSURE, tag("%MW0", { scale: 0.01 }))).toBe("TO_PLC");
  });

  it("refuses a tag whose scaled range cannot carry the signal's range, and a unit that differs", () => {
    expect(tagEngineeringRange({ dataType: "INT16", scale: 0.01, offset: 0 })).toEqual([-327.68, 327.67]);
    expect(tagEngineeringRange({ dataType: "UINT16", scale: -1, offset: 10 })).toEqual([-65525, 10]);
    expect(tagEngineeringRange({ dataType: "FLOAT32", scale: 1, offset: 0 })).toEqual([-Infinity, Infinity]);
    // 0..100 % into an INT16 with scale 0.001: the register ends at 32.767.
    expect(rule(() => checkProcessMapping(SPEED_SP, tag("%QW0", { scale: 0.001 })))).toBe("signal-range");
    expect(checkProcessMapping(SPEED_SP, tag("%QW0", { scale: 0.01, unit: "%" }))).toBe("INTO_PROCESS");
    expect(rule(() => checkProcessMapping(SPEED_SP, tag("%QW0", { scale: 0.01, unit: "Hz" })))).toBe("signal-unit");
    // A tag without a unit takes the signal's.
    expect(checkProcessMapping(PRESSURE, tag("%MW0", { scale: 0.1 }))).toBe("TO_PLC");
  });
});

describe("process bridge: a module's set of mappings", () => {
  const signals = [RUN_CMD, SPEED_SP, RUNNING, PRESSURE, FLOW, LOW_PRESSURE];
  const good = () => [
    { signalKey: "DUTY_RUN_CMD", tag: tag("%QX0.0") },
    { signalKey: "DUTY_SPEED_SETPOINT", tag: tag("%QW0", { scale: 0.01 }) },
    { signalKey: "DUTY_RUNNING", tag: tag("%MX0.0") },
    { signalKey: "DISCHARGE_PRESSURE", tag: tag("%MD0") },
  ];

  it("accepts a complete set and leaves optional signals unmapped", () => {
    expect(checkProcessMappings(signals, good())).toEqual([]);
  });

  it("names every required signal that is not mapped", () => {
    const issues = checkProcessMappings(signals, good().slice(0, 2));
    expect(issues.map((issue) => [issue.rule, issue.signalKey])).toEqual([
      ["required-signal", "DUTY_RUNNING"],
      ["required-signal", "DISCHARGE_PRESSURE"],
    ]);
  });

  it("reports a refused mapping with its rule instead of throwing", () => {
    const issues = checkProcessMappings(signals, [
      ...good().slice(1),
      { signalKey: "DUTY_RUN_CMD", tag: tag("%IX0.0") },
    ]);
    expect(issues).toEqual([expect.objectContaining({ rule: "signal-address", signalKey: "DUTY_RUN_CMD" })]);
  });

  it("refuses a signal mapped twice, a tag used twice and registers that overlap", () => {
    const shared = tag("%MX0.2");
    const issues = checkProcessMappings(signals, [
      ...good(),
      { signalKey: "DUTY_RUNNING", tag: tag("%MX0.1") },
      { signalKey: "LOW_PRESSURE", tag: shared },
    ]);
    expect(issues.map((issue) => issue.rule)).toEqual(["duplicate-signal"]);
    const set = good();
    expect(
      checkProcessMappings(signals, [...set.slice(0, 3), { signalKey: "DISCHARGE_PRESSURE", tag: set[2]!.tag }]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["duplicate-tag"]);
    // %MD0 occupies two registers; a second two-register tag one register later overlaps it.
    const overlapping = tag("%MD0", { protocolAddress: 2049 });
    const low = signal({
      key: "LEVEL",
      direction: "INPUT",
      dataType: "FLOAT32",
      role: "PROCESS_VALUE",
      required: false,
    });
    expect(
      checkProcessMappings([...signals, low], [...good(), { signalKey: "LEVEL", tag: overlapping }]).map(
        (issue) => issue.rule,
      ),
    ).toEqual(["address-overlap"]);
    // The same addresses on another PLC do not overlap.
    expect(
      checkProcessMappings(
        [...signals, low],
        [...good(), { signalKey: "LEVEL", tag: { ...overlapping, plcId: "plc-2" } }],
      ),
    ).toEqual([]);
  });

  it("knows the type's signals and the selected profile", () => {
    const standby = signal({
      key: "STANDBY_RUN_CMD",
      direction: "OUTPUT",
      dataType: "BOOL",
      profiles: ["DUTY_STANDBY"],
    });
    const all = [...signals, standby];
    expect(checkProcessMappings(all, [{ signalKey: "NOPE", tag: tag("%MX0.0") }]).map((issue) => issue.rule)).toContain(
      "module-signal-unknown",
    );
    const single = checkProcessMappings(all, [...good(), { signalKey: "STANDBY_RUN_CMD", tag: tag("%QX2.0") }], {
      profile: "SINGLE_PUMP",
    });
    expect(single.map((issue) => issue.rule)).toEqual(["module-signal-profile"]);
    expect(checkProcessMappings(all, good(), { profile: "DUTY_STANDBY" }).map((issue) => issue.rule)).toEqual([
      "required-signal",
    ]);
  });
});

describe("process bridge: values", () => {
  it("maps directions and converts between the PLC bridge and the model", () => {
    expect(processFlow("OUTPUT")).toBe("INTO_PROCESS");
    expect(processFlow("INPUT")).toBe("TO_PLC");
    expect(processFlow("ALARM")).toBe("TO_PLC");
    expect(processFlow("INTERNAL")).toBeNull();
    expect(locatedRegion("%qx0.0")).toBe("Q");
    expect(locatedRegion("MW0")).toBeNull();
    expect(toModelValue(true)).toBe(1);
    expect(toModelValue(false)).toBe(0);
    expect(toModelValue(12.5)).toBe(12.5);
    expect(toModelValue(Number.NaN)).toBe(0);
    expect(toModelValue(undefined)).toBe(0);
    expect(fromModelValue(1, "BOOL")).toBe(true);
    expect(fromModelValue(0.5, "BOOL")).toBe(true);
    expect(fromModelValue(0, "BOOL")).toBe(false);
    expect(fromModelValue(undefined, "FLOAT32")).toBe(0);
    expect(fromModelValue(3.25, "INT16")).toBe(3.25);
  });
});
