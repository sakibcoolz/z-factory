// @vitest-environment node
import { describe, expect, it } from "vitest";
import { type LinkChange, type LinkCheck, PlcLinkMonitorRuntime } from "./monitor";

const check = (quality: LinkCheck["quality"], linkId = "l1"): LinkCheck => ({
  linkId,
  clientPlcId: "a",
  clientName: "PLC-A",
  serverName: "PLC-B",
  quality,
  reason: quality === "GOOD" ? null : "because",
});

describe("PLC link monitor", () => {
  it("keeps the last health, reports each change once, and keeps the time a state began", async () => {
    let clock = 0;
    const monitor = new PlcLinkMonitorRuntime(() => new Date(Date.UTC(2026, 9, 6, 0, 0, clock)));
    let next: LinkCheck[] = [check("GOOD")];
    const changes: LinkChange[] = [];
    monitor.start("f1", {
      evaluate: async () => next,
      onChanges: (fresh) => void changes.push(...fresh),
      autoTick: false,
    });
    expect(monitor.isRunning("f1")).toBe(true);
    await monitor.tick("f1");
    clock = 5;
    await monitor.tick("f1");
    expect(changes.map((change) => [change.previous, change.current.quality])).toEqual([[null, "GOOD"]]);
    expect(monitor.health("f1")[0]).toMatchObject({
      quality: "GOOD",
      since: "2026-10-06T00:00:00.000Z",
      checkedAt: "2026-10-06T00:00:05.000Z",
    });

    next = [check("DISCONNECTED")];
    clock = 9;
    await monitor.tick("f1");
    expect(changes.at(-1)).toMatchObject({ previous: "GOOD", current: { quality: "DISCONNECTED", reason: "because" } });
    expect(monitor.health("f1")[0]?.since).toBe("2026-10-06T00:00:09.000Z");

    // A link that is no longer there is no longer watched.
    next = [];
    await monitor.tick("f1");
    expect(monitor.health("f1")).toEqual([]);
    monitor.stop("f1");
    expect(monitor.isRunning("f1")).toBe(false);
    expect(monitor.health("f1")).toEqual([]);
  });

  it("keeps a failing check as the last error instead of throwing, and keeps factories apart", async () => {
    const monitor = new PlcLinkMonitorRuntime();
    monitor.start("f1", {
      evaluate: async () => Promise.reject(new Error("db down")),
      onChanges: () => undefined,
      autoTick: false,
    });
    monitor.start("f2", { evaluate: async () => [check("STALE", "l2")], onChanges: () => undefined, autoTick: false });
    await monitor.tick("f1");
    await monitor.tick("f2");
    expect(monitor.lastError("f1")).toBe("db down");
    expect(monitor.health("f1")).toEqual([]);
    expect(monitor.health("f2").map((health) => [health.linkId, health.quality])).toEqual([["l2", "STALE"]]);
    await monitor.stopAll();
    expect(monitor.isRunning("f2")).toBe(false);
  });
});
