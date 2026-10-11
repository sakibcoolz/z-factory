// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DEVICE_PROFILES } from "@/lib/domain/process-sim";
import { SIMULATED_TYPES } from "@/lib/domain/simulation";
import { toDeviceSimDevice, toDeviceSimDevices } from "./devices";

describe("the device configuration for the catalog device runtime", () => {
  it("names a behaviour profile for every simulated type, and nothing else", () => {
    expect(Object.keys(DEVICE_PROFILES).sort()).toEqual([...SIMULATED_TYPES].sort());
    for (const type of SIMULATED_TYPES) expect(DEVICE_PROFILES[type]).toEqual({ profile: type, profileVersion: 1 });
  });

  it("carries the profile, the parameters, the fault overrides and the relationships as links", () => {
    expect(
      toDeviceSimDevices([
        { id: "vfd", name: "VFD-01", type: "VFD", params: { accelTimeS: 2 } },
        { id: "m", name: "M-01", type: "MOTOR", driveId: "vfd" },
        { id: "p", name: "P-01", type: "PUMP", motorId: "m", faults: { DRY_RUN: { severity: "CRITICAL" } } },
        {
          id: "pt",
          name: "PT-01",
          type: "SENSOR",
          measuresId: "p",
          params: { source: { kind: "MEASURED", signal: "pressure" } },
        },
        { id: "sw", name: "HS-01", type: "SWITCH" },
      ]),
    ).toEqual([
      { deviceId: "vfd", name: "VFD-01", profile: "VFD", profileVersion: 1, parameters: { accelTimeS: 2 } },
      { deviceId: "m", name: "M-01", profile: "MOTOR", profileVersion: 1, links: { drive: "vfd" } },
      {
        deviceId: "p",
        name: "P-01",
        profile: "PUMP",
        profileVersion: 1,
        faults: { DRY_RUN: { severity: "CRITICAL" } },
        links: { motor: "m" },
      },
      {
        deviceId: "pt",
        name: "PT-01",
        profile: "SENSOR",
        profileVersion: 1,
        parameters: { source: { kind: "MEASURED", signal: "pressure" } },
        links: { measures: "p" },
      },
      { deviceId: "sw", name: "HS-01", profile: "SWITCH", profileVersion: 1 },
    ]);
  });

  it("refuses a type without a profile", () => {
    expect(() => toDeviceSimDevice({ id: "x", name: "X", type: "RELAY" as never })).toThrow(/no behaviour profile/);
  });
});
