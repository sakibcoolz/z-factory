import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  type DeviceTerminal,
  matchTerminals,
  matchTerminalsToModules,
  type PlcChannel,
  sharedProtocols,
} from "./compatibility";
import { assertConnectionAllowed, assertSignalCompatible, channelAccepts } from "./connection";

const channels = (
  ioType: PlcChannel["ioType"],
  count: number,
  signalType: string,
  acceptedSignalTypes: string[] = [],
) => Array.from({ length: count }, (): PlcChannel => ({ ioType, signalType, acceptedSignalTypes }));

const terminal = (
  terminalLabel: string,
  direction: DeviceTerminal["direction"],
  ioType: DeviceTerminal["ioType"],
  signalType: string,
): DeviceTerminal => ({ terminalLabel, direction, ioType, signalType });

/** 14 DI, 10 DO, 2 AI 0–10 V: the built-in I/O of a small compact PLC. */
const compact = [
  ...channels("DI", 14, "DC_24V"),
  ...channels("DO", 10, "DC_24V"),
  ...channels("AI", 2, "VOLTAGE_0_10V"),
];

describe("channel signal acceptance", () => {
  it("accepts the default type, configured alternatives and signals inside a supported range", () => {
    const analog = { signalType: "CURRENT_4_20MA", acceptedSignalTypes: ["VOLTAGE_PM_10V"] };
    expect(channelAccepts(analog, "CURRENT_4_20MA")).toBe(true);
    expect(channelAccepts(analog, "VOLTAGE_PM_10V")).toBe(true);
    expect(channelAccepts(analog, "VOLTAGE_0_10V")).toBe(true);
    expect(channelAccepts(analog, "CURRENT_0_20MA")).toBe(false);
    expect(channelAccepts({ signalType: "DC_24V" }, "DC_24V")).toBe(true);
  });

  it("names every accepted type when a signal is refused", () => {
    try {
      assertSignalCompatible(
        { direction: "OUTPUT", ioType: "ANALOG", signalType: "CURRENT_0_20MA" },
        { ioType: "AI", signalType: "CURRENT_4_20MA", acceptedSignalTypes: ["VOLTAGE_PM_10V"] },
      );
      throw new Error("expected a DomainError");
    } catch (error) {
      expect((error as DomainError).details).toMatchObject({
        rule: "signal-type",
        accepted: ["CURRENT_4_20MA", "VOLTAGE_PM_10V"],
      });
    }
  });
});

describe("hardwired compatibility with a compact PLC", () => {
  it("lands a device output on a PLC input and a device input on a PLC output", () => {
    const valve = [
      terminal("Y1", "INPUT", "DIGITAL", "DC_24V"),
      terminal("ZSO", "OUTPUT", "DIGITAL", "DC_24V"),
      terminal("ZSC", "OUTPUT", "DIGITAL", "DC_24V"),
    ];
    const match = matchTerminals(valve, compact);
    expect(match.compatible).toBe(true);
    expect(match.terminals.map((entry) => [entry.terminalLabel, entry.required, entry.candidates])).toEqual([
      ["Y1", "DO", 10],
      ["ZSO", "DI", 14],
      ["ZSC", "DI", 14],
    ]);
  });

  it("refuses a signal type or a point class the PLC does not have", () => {
    const current = matchTerminals([terminal("OUT", "OUTPUT", "ANALOG", "CURRENT_4_20MA")], compact);
    expect(current).toMatchObject({
      compatible: false,
      terminals: [{ required: "AI", candidates: 0, satisfied: false }],
    });

    // A speed reference needs an analog output; this PLC has none.
    const drive = matchTerminals(
      [terminal("RUN", "INPUT", "DIGITAL", "DC_24V"), terminal("REF", "INPUT", "ANALOG", "VOLTAGE_0_10V")],
      compact,
    );
    expect(drive.compatible).toBe(false);
    expect(drive.terminals.map((entry) => entry.satisfied)).toEqual([true, false]);
  });

  it("counts channels: three analog signals do not fit two analog inputs", () => {
    const outputs = ["A", "B", "C"].map((label) => terminal(label, "OUTPUT", "ANALOG", "VOLTAGE_0_10V"));
    expect(matchTerminals(outputs.slice(0, 2), compact).compatible).toBe(true);
    const match = matchTerminals(outputs, compact);
    expect(match.compatible).toBe(false);
    expect(match.terminals.filter((entry) => entry.satisfied)).toHaveLength(2);
  });

  it("does not spend a scarce channel on a terminal that had other options", () => {
    // One channel takes only 0–10 V, the other takes both. The 4–20 mA signal must get the flexible one.
    const available = [
      ...channels("AI", 1, "VOLTAGE_0_10V", ["CURRENT_4_20MA"]),
      ...channels("AI", 1, "VOLTAGE_0_10V"),
    ];
    const match = matchTerminals(
      [terminal("U", "OUTPUT", "ANALOG", "VOLTAGE_0_10V"), terminal("I", "OUTPUT", "ANALOG", "CURRENT_4_20MA")],
      available,
    );
    expect(match.compatible).toBe(true);
  });

  it("treats a device without terminals as trivially wired", () => {
    expect(matchTerminals([], compact)).toEqual({ compatible: true, terminals: [] });
  });
});

describe("hardwired compatibility with a modular PLC", () => {
  const modules = [
    { modelName: "DI 16", channels: channels("DI", 16, "DC_24V") },
    { modelName: "AI 8", channels: channels("AI", 8, "CURRENT_4_20MA", ["VOLTAGE_PM_10V"]) },
    { modelName: "AI 4 HS", channels: channels("AI", 4, "VOLTAGE_PM_10V") },
  ];

  it("names the modules that can take each terminal", () => {
    const match = matchTerminalsToModules(
      [terminal("OUT", "OUTPUT", "ANALOG", "VOLTAGE_0_10V"), terminal("SW", "OUTPUT", "DIGITAL", "DC_24V")],
      modules,
    );
    expect(match.compatible).toBe(true);
    expect(match.terminals.map((entry) => entry.modules)).toEqual([["AI 8", "AI 4 HS"], ["DI 16"]]);
  });

  it("is incompatible when no installable module has a channel for a terminal", () => {
    const match = matchTerminalsToModules([terminal("Y1", "INPUT", "DIGITAL", "DC_24V")], modules);
    expect(match).toMatchObject({ compatible: false, terminals: [{ required: "DO", modules: [], satisfied: false }] });
  });
});

describe("protocol compatibility", () => {
  it("returns the protocols both sides have a port for", () => {
    const modbus = [{ protocols: ["MODBUS_TCP"] }];
    expect(sharedProtocols(modbus, modbus)).toEqual(["MODBUS_TCP"]);
    expect(sharedProtocols([{ protocols: [] }], modbus)).toEqual([]);
    expect(sharedProtocols(modbus, [])).toEqual([]);
  });
});

describe("drive relationships", () => {
  const party = (id: string, categoryCode: string, extra: Record<string, unknown> = {}) => ({
    id,
    factoryId: "f",
    categoryCode,
    requiresMotor: false,
    ...extra,
  });
  const drives = (source: ReturnType<typeof party>, target: ReturnType<typeof party>) =>
    assertConnectionAllowed({
      factoryId: "f",
      relationship: "DRIVES",
      source,
      target,
      sourceDrivesCount: 0,
      targetDrivenByCount: 0,
    });
  const servoMotor = party("m", "SERVO_MOTOR", { requiresDrive: true, preferredDriveType: "SERVO" });

  it("lets a VFD, a soft starter or a servo drive drive a motor", () => {
    for (const drive of ["VFD", "SOFT_STARTER", "SERVO_DRIVE"]) {
      expect(() => drives(party("d", drive), party("m", "MOTOR", { preferredDriveType: "VFD" }))).not.toThrow();
    }
    expect(() => drives(party("d", "SERVO_DRIVE"), servoMotor)).not.toThrow();
  });

  it("refuses a servo motor on anything but a servo drive, and non-drives as a source", () => {
    expect(() => drives(party("d", "VFD"), servoMotor)).toThrow(/SERVO drive/);
    expect(() => drives(party("d", "TEMPERATURE_CONTROLLER"), party("m", "MOTOR"))).toThrow(DomainError);
    expect(() => drives(party("d", "VFD"), party("p", "PUMP"))).toThrow(/only drive a motor/);
  });

  it("lets a servo motor mechanically drive equipment like any motor", () => {
    expect(() =>
      assertConnectionAllowed({
        factoryId: "f",
        relationship: "MECHANICALLY_DRIVES",
        source: servoMotor,
        target: party("c", "CONVEYOR", { requiresMotor: true }),
        sourceDrivesCount: 0,
        targetDrivenByCount: 0,
      }),
    ).not.toThrow();
  });
});
