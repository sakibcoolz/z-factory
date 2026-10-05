import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  defaultAnalogScale,
  IO_POINT_LIMITS,
  ioPointAddress,
  ioPointIndex,
  nextBlockIndex,
  suggestDeviceName,
  tagNameFor,
} from "./io-address";

describe("runtime addresses of I/O points", () => {
  it("puts outputs in the output image and inputs in memory", () => {
    expect(ioPointAddress("DO", 0)).toBe("%QX0.0");
    expect(ioPointAddress("DO", 9)).toBe("%QX1.1");
    expect(ioPointAddress("AO", 3)).toBe("%QW3");
    // The runtime accepts simulated field values only in memory (ADR-0010).
    expect(ioPointAddress("DI", 0)).toBe("%MX0.0");
    expect(ioPointAddress("DI", 13)).toBe("%MX1.5");
    expect(ioPointAddress("AI", 1)).toBe("%MW1");
  });

  it("refuses an index beyond the room a PLC has for that class", () => {
    expect(ioPointAddress("DI", IO_POINT_LIMITS.DI - 1)).toBe("%MX127.7");
    for (const action of [
      () => ioPointAddress("DI", IO_POINT_LIMITS.DI),
      () => ioPointAddress("AO", 256),
      () => ioPointAddress("AI", -1),
    ]) {
      expect(action).toThrow(DomainError);
    }
  });

  it("reads an index back from an address of the same class only", () => {
    for (const [ioType, index] of [
      ["DI", 13],
      ["DO", 80],
      ["AI", 7],
      ["AO", 0],
    ] as const) {
      expect(ioPointIndex(ioType, ioPointAddress(ioType, index))).toBe(index);
    }
    expect(ioPointIndex("DI", "%QX0.0")).toBeUndefined();
    expect(ioPointIndex("AI", "%MW1.0")).toBeUndefined();
    expect(ioPointIndex("AI", "%MD4")).toBeUndefined();
    expect(ioPointIndex("DO", "%QX0.8")).toBeUndefined();
  });

  it("starts a new block after everything in use, digital blocks on a byte", () => {
    expect(nextBlockIndex("DI", [], 16)).toBe(0);
    expect(nextBlockIndex("DI", [0, 1, 2, 13], 16)).toBe(16);
    expect(nextBlockIndex("DO", [0, 15], 8)).toBe(16);
    expect(nextBlockIndex("AI", [0, 1, 8], 4)).toBe(9);
    expect(() => nextBlockIndex("AO", [250], 8)).toThrow(DomainError);
  });
});

describe("names and scales derived for wired devices", () => {
  it("turns a device name and terminal into an IEC identifier", () => {
    expect(tagNameFor("VFD-01", "RUN")).toBe("VFD_01_RUN");
    expect(tagNameFor("XV-101", "POS FB")).toBe("XV_101_POS_FB");
    expect(tagNameFor("1st.pump", "K1 AUX")).toBe("T_1st_pump_K1_AUX");
    expect(tagNameFor("PT-101", null)).toBe("PT_101_IO");
    expect(tagNameFor("A".repeat(63), "TERMINAL").length).toBeLessThanOrEqual(64);
  });

  it("suggests the next free numbered name for a category", () => {
    expect(suggestDeviceName("VFD", [])).toBe("VFD-01");
    expect(suggestDeviceName("VFD", ["VFD-01", "vfd-02", "PLC-01"])).toBe("VFD-03");
    expect(suggestDeviceName("PROXIMITY_SENSOR", ["PROXIMITY-SENSOR-01"])).toBe("PROXIMITY-SENSOR-02");
  });

  it("picks an analog scale that keeps the usual range inside an INT16", () => {
    expect(defaultAnalogScale("rpm")).toBe(1);
    expect(defaultAnalogScale("Hz")).toBe(0.01);
    expect(defaultAnalogScale("%")).toBe(0.01);
    expect(defaultAnalogScale(undefined)).toBe(0.1);
  });
});
