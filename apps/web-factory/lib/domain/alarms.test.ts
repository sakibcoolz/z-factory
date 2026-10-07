import { describe, expect, it } from "vitest";
import { type AlarmFacts, desiredAlarms } from "./alarms";

const now = new Date("2026-10-07T10:00:00Z");
const ago = (seconds: number) => new Date(now.getTime() - seconds * 1000);
const healthy = { workers: 1, byState: { ONLINE: 1 }, spooled: 0 };

function agent(overrides: Partial<AlarmFacts> = {}, plc: Partial<AlarmFacts["plcs"][number]> = {}): AlarmFacts {
  return {
    id: "agent-1",
    name: "Edge 1",
    organizationId: "org-1",
    siteId: "site-1",
    status: "ONLINE",
    lastSeenAt: ago(1),
    heartbeat: healthy,
    credentialRevokedAt: null,
    plcs: [
      {
        id: "plc-1",
        name: "PLC-01",
        edgeState: "ONLINE",
        edgeLastError: null,
        alarmTags: [{ tag: "t-overheat", name: "Overheat", value: false }],
        ...plc,
      },
    ],
    ...overrides,
  };
}

const keys = (facts: AlarmFacts[], options?: Parameters<typeof desiredAlarms>[2]) =>
  desiredAlarms(facts, now, options).map((alarm) => `${alarm.key}:${alarm.severity}`);

describe("which alarms are active (TASK-904)", () => {
  it("raises nothing while everything is healthy", () => {
    expect(keys([agent()])).toEqual([]);
  });

  it("raises a HIGH alarm while a PLC alarm tag reads true, whatever its quality now", () => {
    expect(keys([agent({}, { alarmTags: [{ tag: "t-overheat", name: "Overheat", value: true }] })])).toEqual([
      "PLC_TAG|plc-1|t-overheat:HIGH",
    ]);
    // A numeric alarm word: anything but 0 is active.
    expect(keys([agent({}, { alarmTags: [{ tag: "t-code", name: "Code", value: 3 }] })])).toEqual([
      "PLC_TAG|plc-1|t-code:HIGH",
    ]);
    // The last value was true and the agent went silent: it stays raised.
    expect(
      keys([agent({ lastSeenAt: ago(600) }, { alarmTags: [{ tag: "t-overheat", name: "Overheat", value: true }] })]),
    ).toContain("PLC_TAG|plc-1|t-overheat:HIGH");
    // Never read: not raised.
    expect(keys([agent({}, { alarmTags: [{ tag: "t-overheat", name: "Overheat", value: null }] })])).toEqual([]);
  });

  it("raises a HIGH alarm for a disconnected PLC only while its agent is reachable", () => {
    const down = { edgeState: "RECONNECTING", edgeLastError: "connection refused" };
    const [alarm] = desiredAlarms([agent({}, down)], now);
    expect(alarm).toMatchObject({
      key: "PLC_CONNECTION|plc-1|",
      severity: "HIGH",
      message: "PLC PLC-01 is reconnecting: connection refused",
    });
    // The agent is offline: one agent alarm, not one per PLC.
    expect(keys([agent({ status: "OFFLINE" }, down)])).toEqual(["AGENT_CONNECTION|agent-1|:MEDIUM"]);
  });

  it("raises a MEDIUM alarm for an offline or degraded agent, never for one not heard from or revoked", () => {
    expect(keys([agent({ lastSeenAt: ago(120) })])).toEqual(["AGENT_CONNECTION|agent-1|:MEDIUM"]);
    expect(desiredAlarms([agent({ heartbeat: { ...healthy, spooled: 5 } })], now)[0]?.message).toBe(
      "Agent Edge 1 is degraded",
    );
    expect(keys([agent({ status: "UNKNOWN", lastSeenAt: null })])).toEqual([]);
    expect(keys([agent({ status: "OFFLINE", credentialRevokedAt: ago(10) })])).toEqual([]);
  });

  it("judges no connectivity when told it cannot, but still PLC alarm tags", () => {
    const facts = [
      agent({ lastSeenAt: ago(600) }, { edgeState: "DISCONNECTED", alarmTags: [{ tag: "t", name: "T", value: true }] }),
    ];
    expect(keys(facts, { judgeConnectivity: false })).toEqual(["PLC_TAG|plc-1|t:HIGH"]);
  });
});
