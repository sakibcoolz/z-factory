// @vitest-environment node
import { describe, expect, it } from "vitest";
import { BEHAVIOR_PROFILES } from "./behavior-contract";
import {
  areaOf,
  checkRegisterMap,
  findRegisterMap,
  REGISTER_MAPS,
  type RegisterMap,
  wireRegisterMap,
} from "./register-maps";

const vfd = (): RegisterMap => structuredClone(REGISTER_MAPS.VFD_MODBUS_TCP!);

describe("the declared register maps (TASK-1013)", () => {
  it("declares one generic map, for the Modbus drive, that fits the VFD profile", () => {
    expect(Object.keys(REGISTER_MAPS)).toEqual(["VFD_MODBUS_TCP"]);
    for (const map of Object.values(REGISTER_MAPS)) {
      expect(checkRegisterMap(map), map.key).toBeNull();
      expect(map.key).toBe(findRegisterMap(map.key)?.key);
      expect(map.conventions).toEqual({
        addressing: "zero-based",
        byteOrder: "BIG_ENDIAN",
        wordOrder: "HIGH_WORD_FIRST",
      });
    }
    const map = vfd();
    expect(map).toMatchObject({ protocol: "MODBUS_TCP", profile: "VFD", profileVersion: 1, version: 1 });
    // Every signal of the profile is mapped, in the area its direction and kind dictate.
    const profile = BEHAVIOR_PROFILES.VFD!;
    expect(map.registers.map((register) => register.signal).sort()).toEqual(
      profile.signals.map((signal) => signal.key).sort(),
    );
    for (const register of map.registers) {
      const signal = profile.signals.find((candidate) => candidate.key === register.signal)!;
      expect(register.area, register.signal).toBe(areaOf(signal));
      expect(register.access, register.signal).toBe(signal.direction === "IN" ? "READ_WRITE" : "READ_ONLY");
    }
    // The setpoint takes its range from the profile's signal: up to the drive's maximum frequency.
    expect(map.registers.find((register) => register.signal === "frequencySetpoint")).toMatchObject({
      area: "HOLDING_REGISTER",
      address: 0,
      dataType: "UINT16",
      scale: 0.1,
      unit: "Hz",
      role: "SETPOINT",
      range: { min: 0, maxParameter: "maxFrequencyHz" },
    });
    expect(map.registers.find((register) => register.signal === "running")).toMatchObject({
      area: "DISCRETE_INPUT",
      address: 0,
      dataType: "BOOL",
      access: "READ_ONLY",
      range: null,
    });
  });

  it("refuses a map that does not fit its profile", () => {
    const broken = (change: (map: RegisterMap) => void): string | null => {
      const map = vfd();
      change(map);
      return checkRegisterMap(map);
    };
    const registers = (map: RegisterMap) => map.registers as Array<RegisterMap["registers"][number]>;
    expect(broken((map) => (map.profile = "BOILER"))).toMatch(/does not exist/);
    expect(broken((map) => (map.profileVersion = 2))).toMatch(/version/);
    expect(broken((map) => (registers(map)[0]!.signal = "flow"))).toMatch(/not a signal/);
    expect(broken((map) => (registers(map)[4]!.area = "COIL"))).toMatch(/lives in DISCRETE_INPUT/);
    expect(broken((map) => (registers(map)[0]!.access = "READ_ONLY"))).toMatch(/access/);
    expect(broken((map) => (registers(map)[0]!.role = "FEEDBACK"))).toMatch(/role/);
    expect(broken((map) => (registers(map)[1]!.address = 0))).toMatch(/used twice/);
    expect(broken((map) => (registers(map)[3]!.scale = 0))).toMatch(/scale/);
    expect(broken((map) => (registers(map)[7]!.range = { min: 0 }))).toMatch(/only a writable register/);
    expect(broken((map) => (registers(map)[3]!.range = { maxParameter: "ratedFlow" }))).toMatch(/parameter ratedFlow/);
    expect(broken((map) => (registers(map)[3]!.dataType = "BOOL"))).toMatch(/bit areas carry BOOL/);
  });

  it("travels over the wire without nulls, as the runtime describes it", () => {
    const wire = wireRegisterMap(vfd());
    expect(JSON.stringify(wire)).not.toContain("null");
    const registers = wire.registers as Array<Record<string, unknown>>;
    expect(registers[0]).toEqual({
      signal: "run",
      area: "COIL",
      address: 0,
      dataType: "BOOL",
      wordCount: 1,
      scale: 1,
      offset: 0,
      access: "READ_WRITE",
      role: "COMMAND",
    });
    expect(registers[3]).toMatchObject({ unit: "Hz", range: { min: 0, maxParameter: "maxFrequencyHz" } });
  });
});
