import { describe, expect, it } from "vitest";
import { buildModuleIo, type StoredModuleBinding } from "@/lib/domain/module-io-view";
import type { ProcessSignalTag } from "@/lib/domain/process-bridge";
import type { ModuleSignal } from "@/lib/domain/process-module";

const signal = (
  key: string,
  direction: ModuleSignal["direction"],
  dataType: ModuleSignal["dataType"],
  extra: Partial<ModuleSignal> = {},
): ModuleSignal => ({
  key,
  name: key,
  description: null,
  direction,
  dataType,
  role: direction === "OUTPUT" ? "COMMAND" : direction === "ALARM" ? "ALARM" : "FEEDBACK",
  unit: null,
  signalType: null,
  required: true,
  rangeMin: null,
  rangeMax: null,
  roleKey: null,
  profiles: [],
  ...extra,
});

const SIGNALS = [
  signal("RUN_CMD", "OUTPUT", "BOOL"),
  signal("SPEED_SP", "OUTPUT", "FLOAT32", { required: false }),
  signal("RUNNING", "INPUT", "BOOL"),
  signal("PRESSURE", "INPUT", "FLOAT32"),
  signal("FLOW", "INTERNAL", "FLOAT32", { required: false }),
  signal("LOW", "ALARM", "BOOL", { required: false }),
  signal("STANDBY_CMD", "OUTPUT", "BOOL", { profiles: ["DUTY_STANDBY"] }),
];

const tag = (
  id: string,
  logicalAddress: string,
  dataType: ProcessSignalTag["dataType"],
  plcId = "plc-1",
): ProcessSignalTag => ({
  id,
  plcId,
  name: `T_${id}`,
  dataType,
  role: "STATUS",
  accessMode: "READ_ONLY",
  logicalAddress,
  protocolArea: logicalAddress.includes("X") ? "COIL" : "HOLDING_REGISTER",
  protocolAddress: Number(id.replace(/\D/g, "")),
  wordCount: dataType === "FLOAT32" ? 2 : 1,
  byteOrder: "BIG_ENDIAN",
  wordOrder: "HIGH_WORD_FIRST",
  scale: 1,
  offset: 0,
  unit: null,
  sourceDeviceInstanceId: null,
});

const binding = (signalKey: string, t: ProcessSignalTag, plcName = "PLC-01"): StoredModuleBinding => ({
  mappingId: `m-${signalKey}`,
  signalKey,
  plcName,
  tag: t,
  ioPointId: null,
});

describe("module I/O registry rows", () => {
  it("lists the consumed signals of the profile with their state, and the internal ones apart", () => {
    const io = buildModuleIo(SIGNALS, "SINGLE_PUMP", [
      binding("RUN_CMD", tag("1", "%QX0.0", "BOOL")),
      binding("RUNNING", tag("2", "%MX0.0", "BOOL")),
    ]);
    expect(io.rows.map((row) => [row.signal.key, row.state, row.blocking])).toEqual([
      ["RUN_CMD", "BOUND", false],
      ["SPEED_SP", "UNBOUND", false],
      ["RUNNING", "BOUND", false],
      ["PRESSURE", "UNBOUND", true],
      ["LOW", "UNBOUND", false],
    ]);
    expect(io.internal.map((s) => s.key)).toEqual(["FLOW"]);
    expect(io.blocking).toBe(true);
    expect(io.counts).toEqual({
      INPUT: { total: 2, bound: 1, invalid: 0, requiredUnbound: 1 },
      OUTPUT: { total: 2, bound: 1, invalid: 0, requiredUnbound: 0 },
      ALARM: { total: 1, bound: 0, invalid: 0, requiredUnbound: 0 },
    });
    expect(io.rows[0]?.binding).toMatchObject({
      plcName: "PLC-01",
      tagName: "T_1",
      logicalAddress: "%QX0.0",
      modbusArea: "COIL",
    });
  });

  it("re-checks every binding: a tag that no longer fits is INVALID, and blocks when the signal is required", () => {
    const taken = { ...tag("2", "%MX0.0", "BOOL"), sourceDeviceInstanceId: "dev-1" };
    const io = buildModuleIo(SIGNALS, "SINGLE_PUMP", [
      binding("RUN_CMD", tag("1", "%QX0.0", "BOOL")),
      binding("RUNNING", taken),
      binding("PRESSURE", tag("3", "%MD0", "FLOAT32")),
      binding("LOW", tag("4", "%QX0.1", "BOOL")),
    ]);
    expect(io.rows.find((row) => row.signal.key === "RUNNING")).toMatchObject({
      state: "INVALID",
      blocking: true,
      issue: { rule: "tag-in-use" },
    });
    expect(io.rows.find((row) => row.signal.key === "LOW")).toMatchObject({
      state: "INVALID",
      blocking: false,
      issue: { rule: "signal-address" },
    });
    expect(io.counts.INPUT.invalid).toBe(1);
    expect(io.counts.ALARM.invalid).toBe(1);
    // An invalid binding is not counted as the PLC's use.
    expect(io.plcs).toEqual([{ plcId: "plc-1", plcName: "PLC-01", inputs: 1, outputs: 1, alarms: 0 }]);
  });

  it("counts what every PLC gives, and follows the profile", () => {
    const io = buildModuleIo(SIGNALS, "DUTY_STANDBY", [
      binding("RUN_CMD", tag("1", "%QX0.0", "BOOL")),
      binding("STANDBY_CMD", tag("5", "%QX0.0", "BOOL", "plc-2"), "PLC-02"),
      binding("LOW", tag("6", "%MX0.1", "BOOL", "plc-2"), "PLC-02"),
    ]);
    expect(io.rows.map((row) => row.signal.key)).toContain("STANDBY_CMD");
    expect(io.plcs).toEqual([
      { plcId: "plc-1", plcName: "PLC-01", inputs: 0, outputs: 1, alarms: 0 },
      { plcId: "plc-2", plcName: "PLC-02", inputs: 0, outputs: 1, alarms: 1 },
    ]);
    // In SINGLE_PUMP the standby command does not exist: its binding is reported, not listed as a row.
    const single = buildModuleIo(SIGNALS, "SINGLE_PUMP", [binding("STANDBY_CMD", tag("5", "%QX0.0", "BOOL"))]);
    expect(single.rows.map((row) => row.signal.key)).not.toContain("STANDBY_CMD");
  });
});
