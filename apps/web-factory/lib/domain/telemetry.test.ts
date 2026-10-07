import { describe, expect, it } from "vitest";
import {
  advanceLatest,
  batchTimeProblem,
  dayKey,
  type Latest,
  projectQuality,
  storedValue,
  telemetryBatchSchema,
} from "./telemetry";

const t = (seconds: number) => new Date(Date.UTC(2026, 9, 7, 10, 0, seconds));
const value = (tag: string, quality: "GOOD" | "BAD" | "DISCONNECTED", v: number | boolean | null) => ({
  tag,
  quality,
  ...storedValue(v),
});

describe("telemetry batches (TASK-903)", () => {
  it("reads a batch as the agent publishes it, replayed or not", () => {
    const batch = telemetryBatchSchema.parse({
      schema: "zfactory.telemetry",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      replayed: true,
      plcId: "plc-1",
      configVersion: 3,
      at: "2026-10-07T10:00:00.123456789Z",
      values: [
        { id: "t-speed", name: "Speed_SP", value: 42.5, quality: "GOOD", at: "2026-10-07T10:00:00.123456789Z" },
        { id: "t-run", name: "Running", value: true, quality: "GOOD", at: "2026-10-07T10:00:00.123456789Z" },
        { id: "t-new", name: "Never", value: null, quality: "DISCONNECTED", at: "0001-01-01T00:00:00Z" },
      ],
    });
    expect(batch.values.map((entry) => entry.value)).toEqual([42.5, true, null]);
    expect(storedValue(true)).toEqual({ num: null, bool: true });
    expect(storedValue(null)).toEqual({ num: null, bool: null });
    expect(
      telemetryBatchSchema.safeParse({ ...batch, values: [{ id: "x", value: "high", quality: "GOOD" }] }).success,
    ).toBe(false);
  });

  it("advances the latest values the same way whatever order batches arrive in", () => {
    const batches = [
      { at: t(1), values: [value("a", "GOOD", 1), value("b", "GOOD", true)] },
      { at: t(2), values: [value("a", "BAD", 1), value("b", "GOOD", false)] },
      { at: t(3), values: [value("a", "GOOD", 3), value("b", "GOOD", false)] },
    ];
    const forward = advanceLatest(new Map(), batches);
    const backward = advanceLatest(new Map(), [...batches].reverse());
    expect([...backward.latest.values()]).toEqual([...forward.latest.values()]);
    expect(forward.latest.get("a")).toMatchObject({ num: 3, quality: "GOOD", at: t(3) });
    expect(forward.changes.map((change) => `${change.tag}:${change.from}->${change.to}`)).toEqual([
      "a:null->GOOD",
      "b:null->GOOD",
      "a:GOOD->BAD",
      "a:BAD->GOOD",
    ]);
  });

  it("leaves newer latest values alone: a replayed or duplicated batch changes nothing", () => {
    const stored = new Map<string, Latest>([["a", { tag: "a", quality: "GOOD", at: t(5), num: 5, bool: null }]]);
    const result = advanceLatest(stored, [
      { at: t(5), values: [value("a", "BAD", 9)] },
      { at: t(2), values: [value("a", "BAD", 2)] },
    ]);
    expect(result.changed.size).toBe(0);
    expect(result.changes).toEqual([]);
    expect(result.latest.get("a")).toMatchObject({ num: 5 });
  });

  it("projects quality: disconnected without a connection, stale after three polls", () => {
    const latest = { quality: "GOOD" as const, at: t(0) };
    expect(projectQuality(latest, "ONLINE", 1000, t(2))).toBe("GOOD");
    expect(projectQuality(latest, "DEGRADED", 1000, t(3))).toBe("GOOD");
    expect(projectQuality(latest, "ONLINE", 1000, t(4))).toBe("STALE");
    expect(projectQuality(latest, "RECONNECTING", 1000, t(1))).toBe("DISCONNECTED");
    expect(projectQuality(latest, "UNKNOWN", 1000, t(1))).toBe("DISCONNECTED");
    expect(projectQuality({ quality: "BAD", at: t(0) }, "ONLINE", 1000, t(1))).toBe("BAD");
  });

  it("keys partitions by UTC day and refuses batches past the retention or from the future", () => {
    expect(dayKey(new Date("2026-10-07T23:59:59.999Z"))).toBe("20261007");
    expect(dayKey(new Date("2026-10-08T00:00:00Z"))).toBe("20261008");
    const now = new Date("2026-10-07T12:00:00Z");
    expect(batchTimeProblem(new Date("2026-09-08T00:00:00Z"), now, 30)).toBeNull();
    expect(batchTimeProblem(new Date("2026-09-07T23:59:59Z"), now, 30)).toBe("expired");
    expect(batchTimeProblem(new Date("2026-10-07T12:05:00Z"), now, 30)).toBeNull();
    expect(batchTimeProblem(new Date("2026-10-07T12:30:00Z"), now, 30)).toBe("future");
  });
});
