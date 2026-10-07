import { describe, expect, it } from "vitest";
import { projectAgent, projectPlc } from "./connectivity";

const now = new Date("2026-10-07T10:00:00Z");
const before = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const healthy = { workers: 2, byState: { ONLINE: 2 }, spooled: 0 };

describe("agent connectivity (TASK-902)", () => {
  it("is unknown until the agent is heard from", () => {
    expect(projectAgent({ status: "UNKNOWN", lastSeenAt: null, heartbeat: null }, now).state).toBe("UNKNOWN");
  });

  it("is online with timely heartbeats and every PLC worker online", () => {
    const view = projectAgent({ status: "ONLINE", lastSeenAt: before(5), heartbeat: healthy }, now);
    expect(view).toEqual({ state: "ONLINE", reasons: [], silentForMs: 5000 });
  });

  it("is degraded when the heartbeat is late, a PLC is not online, or telemetry is spooled", () => {
    expect(projectAgent({ status: "ONLINE", lastSeenAt: before(30), heartbeat: healthy }, now)).toMatchObject({
      state: "DEGRADED",
      reasons: ["heartbeat late: last heard 30 s ago"],
    });
    expect(
      projectAgent(
        { status: "ONLINE", lastSeenAt: before(1), heartbeat: { workers: 3, byState: { ONLINE: 1, RECONNECTING: 2 } } },
        now,
      ).reasons,
    ).toEqual(["2 of 3 PLC workers not online"]);
    expect(
      projectAgent({ status: "ONLINE", lastSeenAt: before(1), heartbeat: { ...healthy, spooled: 40 } }, now).state,
    ).toBe("DEGRADED");
  });

  it("is offline when it said so, when silent too long, or when revoked", () => {
    expect(projectAgent({ status: "OFFLINE", lastSeenAt: before(1), heartbeat: healthy }, now).state).toBe("OFFLINE");
    expect(projectAgent({ status: "ONLINE", lastSeenAt: before(61), heartbeat: healthy }, now)).toMatchObject({
      state: "OFFLINE",
      reasons: ["silent for 61 s"],
    });
    // A retained "online" alone proves nothing.
    expect(projectAgent({ status: "ONLINE", lastSeenAt: null, heartbeat: null }, now).state).toBe("OFFLINE");
    expect(
      projectAgent({ status: "ONLINE", lastSeenAt: before(1), heartbeat: healthy, credentialRevokedAt: before(1) }, now)
        .state,
    ).toBe("OFFLINE");
  });

  it("follows the configured heartbeat interval", () => {
    const facts = { status: "ONLINE" as const, lastSeenAt: before(30), heartbeat: healthy };
    expect(projectAgent(facts, now, { heartbeatMs: 30_000 }).state).toBe("ONLINE");
    expect(projectAgent(facts, now, { heartbeatMs: 4_000 }).state).toBe("OFFLINE");
  });
});

describe("PLC connectivity (TASK-902)", () => {
  it("shows what the agent reported while the agent is reachable", () => {
    expect(projectPlc({ edgeState: "ONLINE", edgeLastError: null }, "ONLINE")).toEqual({ state: "ONLINE", note: null });
    expect(projectPlc({ edgeState: "RECONNECTING", edgeLastError: "connection refused" }, "DEGRADED")).toEqual({
      state: "RECONNECTING",
      note: "connection refused",
    });
    expect(projectPlc({ edgeState: "REMOVED", edgeLastError: null }, "ONLINE").state).toBe("REMOVED");
  });

  it("is unknown while the agent is offline", () => {
    expect(projectPlc({ edgeState: "ONLINE", edgeLastError: null }, "OFFLINE")).toEqual({
      state: "UNKNOWN",
      note: "last reported online",
    });
  });
});
