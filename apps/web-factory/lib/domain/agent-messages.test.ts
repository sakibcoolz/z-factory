import { describe, expect, it } from "vitest";
import { agentBrokerIdentity } from "./broker-access";
import { agentHeartbeatSchema, agentStatusSchema, parseAgentTopic, plcStateSchema } from "./agent-messages";

describe("agent topics (TASK-902)", () => {
  it("parses every topic an agent publishes", () => {
    expect(parseAgentTopic("zfactory/plant-1/edge-1/agent/status")).toEqual({
      kind: "status",
      siteKey: "plant-1",
      agentKey: "edge-1",
    });
    expect(parseAgentTopic("zfactory/plant-1/edge-1/agent/heartbeat")?.kind).toBe("heartbeat");
    expect(parseAgentTopic("zfactory/plant-1/edge-1/state/plc_1")).toEqual({
      kind: "state",
      siteKey: "plant-1",
      agentKey: "edge-1",
      plcId: "plc_1",
    });
    expect(parseAgentTopic("zfactory/plant-1/edge-1/telemetry/plc-1")?.kind).toBe("telemetry");
    expect(parseAgentTopic("zfactory/plant-1/edge-1/ack/plc-1")?.kind).toBe("ack");
  });

  it("refuses anything else", () => {
    for (const topic of [
      "zfactory/plant-1/edge-1/agent/other",
      "zfactory/plant-1/edge-1/state",
      "zfactory/plant-1/edge-1/state/a/b",
      "zfactory/plant.1/edge-1/agent/status",
      "zfactory//edge-1/agent/status",
      "other/plant-1/edge-1/agent/status",
      "zfactory/plant-1/edge-1/config/plc-1",
      "$SYS/broker/uptime",
    ]) {
      expect(parseAgentTopic(topic), topic).toBeNull();
    }
  });

  it("reads the agent's messages as it sends them", () => {
    const at = "2026-10-07T10:00:00.123456789Z";
    expect(
      agentStatusSchema.parse({
        schema: "zfactory.agent-status",
        version: 1,
        siteId: "plant-1",
        agentId: "edge-1",
        status: "offline",
        agentVersion: "0.3.0",
        at,
      }).at,
    ).toBeInstanceOf(Date);
    const heartbeat = agentHeartbeatSchema.parse({
      schema: "zfactory.agent-heartbeat",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      agentVersion: "0.3.0",
      uptimeS: 12,
      workers: 2,
      byState: { ONLINE: 1, RECONNECTING: 1 },
      queue: { depth: 0, dropped: 3 },
      spooled: 0,
      published: 40,
      at,
    });
    expect(heartbeat.byState).toEqual({ ONLINE: 1, RECONNECTING: 1 });
    const state = plcStateSchema.parse({
      schema: "zfactory.plc-state",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      plcId: "plc-1",
      name: "PLC-01",
      state: "ONLINE",
      configVersion: 3,
      endpoint: "10.0.0.15:502",
      lastPollAt: null,
      lastError: "",
      reconnects: 0,
      at,
    });
    expect(state.lastPollAt).toBeNull();
    expect(agentStatusSchema.safeParse({ schema: "zfactory.agent-status", version: 2 }).success).toBe(false);
  });
});

describe("an agent's broker access (TASK-902)", () => {
  it("is limited to its own topics and bound to its client id", () => {
    const identity = agentBrokerIdentity("plant-1", "edge-1");
    expect(identity.username).toBe("agent:plant-1:edge-1");
    expect(identity.clientId).toBe("zfactory-agent-plant-1-edge-1");
    for (const acl of identity.acls) expect(acl.topic.startsWith("zfactory/plant-1/edge-1/")).toBe(true);
    const subscribe = identity.acls.filter((acl) => acl.acltype === "subscribePattern").map((acl) => acl.topic);
    expect(subscribe).toEqual(["zfactory/plant-1/edge-1/command/+"]);
    const publish = identity.acls.filter((acl) => acl.acltype === "publishClientSend").map((acl) => acl.topic);
    expect(publish).not.toContain("zfactory/plant-1/edge-1/command/+");
    expect(publish).toContain("zfactory/plant-1/edge-1/agent/status");
    expect(() => agentBrokerIdentity("plant/#", "edge-1")).toThrow();
  });
});
