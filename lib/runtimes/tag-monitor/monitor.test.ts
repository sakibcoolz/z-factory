// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import type { ModbusArea } from "@/lib/domain/tag";
import { type MonitorCycle, type MonitoredTag, planReads, TagMonitorRuntime } from "./monitor";
import { DEFAULT_SAMPLING_POLICY, sampleValue, shouldStore } from "./sampler";

const tag = (overrides: Partial<MonitoredTag> & Pick<MonitoredTag, "name" | "area" | "address">): MonitoredTag => ({
  id: `tag-${overrides.name}`,
  role: "STATUS",
  wordCount: 1,
  encoding: { dataType: overrides.area === "COIL" ? "BOOL" : "INT16" },
  deviceId: null,
  ...overrides,
});

const TAGS: MonitoredTag[] = [
  tag({ name: "Run", area: "COIL", address: 0 }),
  tag({ name: "Limit", area: "COIL", address: 8193 }),
  tag({ name: "Speed", area: "HOLDING_REGISTER", address: 1024, encoding: { dataType: "INT16", scale: 0.1 } }),
  tag({
    name: "Pressure",
    area: "HOLDING_REGISTER",
    address: 2048,
    wordCount: 2,
    encoding: { dataType: "FLOAT32" },
  }),
];

/** A PLC in memory: coils and holding registers, a request log, and a switch to make it go away. */
class FakePlc {
  coils = new Array<boolean>(9000).fill(false);
  holding = new Array<number>(5000).fill(0);
  requests: Array<{ area: ModbusArea; address: number; count: number }> = [];
  failure: DomainError | Error | undefined;
  refuse: ModbusArea | undefined;

  read = async (area: ModbusArea, address: number, count: number) => {
    this.requests.push({ area, address, count });
    if (this.failure) throw this.failure;
    if (this.refuse === area)
      throw new DomainError("RUNTIME_FAILURE", "Illegal data address.", { rule: "modbus-exception" });
    const source: Array<number | boolean> = area === "COIL" ? this.coils : this.holding;
    return source.slice(address, address + count);
  };

  setFloat(address: number, value: number) {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(value, 0);
    this.holding[address] = buffer.readUInt16BE(0);
    this.holding[address + 1] = buffer.readUInt16BE(2);
  }
}

const unreachable = () =>
  new DomainError("RUNTIME_FAILURE", "The Modbus server is not reachable.", { rule: "modbus-unreachable" });

function setup() {
  const plc = new FakePlc();
  let now = 0;
  let wall = Date.parse("2026-10-05T05:00:00.000Z");
  const monitor = new TagMonitorRuntime({ now: () => now, date: () => new Date(wall) });
  const cycles: MonitorCycle[] = [];
  const links: boolean[] = [];
  monitor.start({
    plcId: "plc-1",
    factoryId: "factory-1",
    mappingVersion: 4,
    tags: TAGS,
    read: plc.read,
    autoTick: false,
    hooks: { onCycle: (_plc, cycle) => void cycles.push(cycle), onLink: (_plc, up) => void links.push(up) },
  });
  const value = (name: string) => monitor.readings("plc-1").find((reading) => reading.name === name);
  return {
    plc,
    monitor,
    cycles,
    links,
    value,
    tick: () => monitor.tick("plc-1"),
    elapse: (ms: number) => {
      now += ms;
      wall += ms;
    },
  };
}

describe("read planning", () => {
  it("reads neighbouring tags in one request and distant ones separately", () => {
    expect(planReads(TAGS)).toEqual([
      { area: "COIL", address: 0, count: 1 },
      { area: "COIL", address: 8193, count: 1 },
      { area: "HOLDING_REGISTER", address: 1024, count: 1 },
      { area: "HOLDING_REGISTER", address: 2048, count: 2 },
    ]);
    const close = [0, 3, 40, 70].map((address) => tag({ name: `C${address}`, area: "COIL", address }));
    expect(planReads(close)).toEqual([{ area: "COIL", address: 0, count: 71 }]);
    const registers = [0, 10, 200].map((address) => tag({ name: `R${address}`, area: "HOLDING_REGISTER", address }));
    expect(planReads(registers)).toEqual([
      { area: "HOLDING_REGISTER", address: 0, count: 11 },
      { area: "HOLDING_REGISTER", address: 200, count: 1 },
    ]);
  });
});

describe("tag monitor", () => {
  it("knows nothing before its first cycle, then reads typed values with their time", async () => {
    const { plc, monitor, cycles, links, value, tick } = setup();
    expect(monitor.readings("plc-1").map((reading) => [reading.value, reading.quality, reading.readAt])).toEqual(
      TAGS.map(() => [null, "DISCONNECTED", null]),
    );

    plc.coils[0] = true;
    plc.holding[1024] = 425;
    plc.setFloat(2048, 2.5);
    await tick();
    expect(value("Run")).toEqual({
      plcId: "plc-1",
      name: "Run",
      value: true,
      quality: "GOOD",
      readAt: "2026-10-05T05:00:00.000Z",
    });
    expect(value("Speed")?.value).toBeCloseTo(42.5);
    expect(value("Pressure")?.value).toBeCloseTo(2.5);
    expect(value("Limit")?.value).toBe(false);
    expect(links).toEqual([true]);
    expect(cycles[0]).toMatchObject({ reachable: true });
    expect(cycles[0]?.changed).toHaveLength(4);
    expect(plc.requests).toHaveLength(4);
    expect(monitor.mappingVersion("plc-1")).toBe(4);
  });

  it("reports only what changed, but confirms every cycle in which the PLC answered", async () => {
    const { plc, cycles, value, tick, elapse } = setup();
    await tick();
    elapse(500);
    await tick();
    expect(cycles[1]).toMatchObject({ reachable: true, changed: [] });
    // Unchanged values are as fresh as the last answer.
    expect(value("Run")?.readAt).toBe("2026-10-05T05:00:00.500Z");

    plc.holding[1024] = 10;
    elapse(500);
    await tick();
    expect(cycles[2]?.changed.map((reading) => [reading.name, reading.value])).toEqual([["Speed", 1]]);
    expect(cycles[2]?.all).toHaveLength(4);
  });

  it("keeps the last values of a PLC that stops answering, marked disconnected, and asks again only after a pause", async () => {
    const { plc, cycles, links, value, tick, elapse } = setup();
    plc.holding[1024] = 425;
    await tick();
    plc.failure = unreachable();
    plc.requests.length = 0;
    elapse(500);
    await tick();
    expect(value("Speed")).toMatchObject({ quality: "DISCONNECTED", readAt: "2026-10-05T05:00:00.000Z" });
    expect(value("Speed")?.value).toBeCloseTo(42.5);
    expect(cycles.at(-1)).toMatchObject({ reachable: false });
    expect(cycles.at(-1)?.changed).toHaveLength(4);
    // One failed request is enough to know: the other ranges are not asked for.
    expect(plc.requests).toHaveLength(1);
    // The values are marked at once, but one missed answer is not yet a lost connection.
    expect(links).toEqual([true]);

    // Not asked on every cycle while it is away.
    elapse(500);
    await tick();
    expect(plc.requests).toHaveLength(1);
    expect(cycles).toHaveLength(2);

    // Still away at the next attempt: now the link is down.
    elapse(1500);
    await tick();
    expect(plc.requests).toHaveLength(2);
    expect(links).toEqual([true, false]);

    plc.failure = undefined;
    plc.holding[1024] = 300;
    elapse(2000);
    await tick();
    expect(value("Speed")).toMatchObject({ value: 30, quality: "GOOD" });
    expect(links).toEqual([true, false, true]);
  });

  it("does not report a PLC that misses one answer, as during a program load, as disconnected", async () => {
    const { plc, links, value, tick, elapse } = setup();
    plc.holding[1024] = 425;
    await tick();
    plc.failure = unreachable();
    elapse(500);
    await tick();
    expect(value("Speed")?.quality).toBe("DISCONNECTED");
    plc.failure = undefined;
    elapse(2000);
    await tick();
    expect(value("Speed")).toMatchObject({ quality: "GOOD" });
    expect(links).toEqual([true]);
  });

  it("marks only the refused range bad when the PLC answers but rejects an address", async () => {
    const { plc, links, value, tick } = setup();
    plc.coils[0] = true;
    await tick();
    plc.refuse = "HOLDING_REGISTER";
    await tick();
    expect(value("Run")).toMatchObject({ value: true, quality: "GOOD" });
    expect(value("Speed")?.quality).toBe("BAD");
    expect(value("Pressure")?.quality).toBe("BAD");
    // The PLC is still there.
    expect(links).toEqual([true]);
  });

  it("treats any unexpected read failure as a PLC that is gone", async () => {
    const context = setup();
    const { plc, links, value, tick } = context;
    const { elapse } = context;
    plc.failure = new Error("socket hang up");
    await tick();
    expect(value("Run")?.quality).toBe("DISCONNECTED");
    // A PLC that never answered is reported once it is clear that it stays away.
    expect(links).toEqual([]);
    elapse(2000);
    await tick();
    expect(links).toEqual([false]);
  });

  it("keeps reading when a hook fails, and forgets everything when it is stopped", async () => {
    const plc = new FakePlc();
    const monitor = new TagMonitorRuntime();
    monitor.start({
      plcId: "plc-1",
      factoryId: "factory-1",
      mappingVersion: 1,
      tags: TAGS,
      read: plc.read,
      autoTick: false,
      hooks: {
        onCycle: () => {
          throw new Error("database is down");
        },
      },
    });
    await monitor.tick("plc-1");
    plc.coils[0] = true;
    await monitor.tick("plc-1");
    expect(monitor.readings("plc-1").find((reading) => reading.name === "Run")?.value).toBe(true);
    expect(monitor.status("plc-1")).toMatchObject({ up: true, cycles: 2, lastError: "database is down" });
    expect(() =>
      monitor.start({ plcId: "plc-1", factoryId: "factory-1", mappingVersion: 1, tags: [], read: plc.read }),
    ).toThrowError("already monitored");

    expect(await monitor.stop("plc-1")).toHaveLength(4);
    expect(monitor.isRunning("plc-1")).toBe(false);
    expect(monitor.readings("plc-1")).toEqual([]);
    expect(monitor.readingsOfFactory("factory-1")).toEqual([]);
    expect(await monitor.stop("plc-1")).toEqual([]);
  });
});

describe("telemetry sampling", () => {
  const policy = { minIntervalMs: 1000, maxIntervalMs: 60_000, deadbandRatio: 0.01 };
  const last = { value: 100, quality: "GOOD" as const, atMs: 0 };
  const good = (value: number) => ({ value, quality: "GOOD" as const });

  it("stores the first value and every change of quality", () => {
    expect(shouldStore(undefined, good(0), 0, policy, 1)).toBe(true);
    expect(shouldStore(last, { value: 100, quality: "DISCONNECTED" }, 10, policy, 1)).toBe(true);
  });

  it("does not store faster than the minimum interval, however much the value moves", () => {
    expect(shouldStore(last, good(500), 999, policy, 0.1)).toBe(false);
    expect(shouldStore(last, good(500), 1000, policy, 0.1)).toBe(true);
  });

  it("stores a change that reaches the deadband and ignores one that does not", () => {
    expect(shouldStore(last, good(100.9), 5000, policy, 0.1)).toBe(false);
    expect(shouldStore(last, good(101), 5000, policy, 0.1)).toBe(true);
    expect(shouldStore(last, good(99), 5000, policy, 0.1)).toBe(true);
    // Around zero the relative band is nothing: the tag's own resolution is the floor.
    const zero = { value: 0, quality: "GOOD" as const, atMs: 0 };
    expect(shouldStore(zero, good(0.05), 5000, policy, 0.1)).toBe(false);
    expect(shouldStore(zero, good(0.1), 5000, policy, 0.1)).toBe(true);
    // A BOOL has a resolution of 1: every change of state is stored.
    expect(shouldStore(zero, good(1), 5000, policy, 1)).toBe(true);
  });

  it("stores an unchanged value as a sign of life after the maximum interval", () => {
    expect(shouldStore(last, good(100), 59_999, policy, 0.1)).toBe(false);
    expect(shouldStore(last, good(100), 60_000, policy, 0.1)).toBe(true);
    expect(DEFAULT_SAMPLING_POLICY).toEqual({ minIntervalMs: 1000, maxIntervalMs: 60_000, deadbandRatio: 0.01 });
  });

  it("stores a BOOL as 0 or 1 and nothing for a value that is not a number", () => {
    expect([true, false, 4.2, null, Number.NaN, Number.POSITIVE_INFINITY].map(sampleValue)).toEqual([
      1,
      0,
      4.2,
      null,
      null,
      null,
    ]);
  });
});
