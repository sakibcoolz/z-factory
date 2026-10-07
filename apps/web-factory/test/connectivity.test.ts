import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { AgentBrokerIdentity } from "@/lib/domain/broker-access";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type BrokerAdmin, BrokerUnavailableError } from "@/lib/mqtt/dynsec";
import { Ingestor } from "@/lib/mqtt/ingest";
import { issueAgentCredentials, revokeAgentCredentials } from "@/lib/services/onboarding-service";
import { createAgent, createSite, getAgent, listAudit, registerDeployment } from "@/lib/services/site-service";
import { actorForSession, addMember, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { deploymentFile, openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;

const status = (status: "online" | "offline", at: string, agentId = "edge-1") =>
  Buffer.from(
    JSON.stringify({
      schema: "zfactory.agent-status",
      version: 1,
      siteId: "plant-1",
      agentId,
      status,
      agentVersion: "0.3.0",
      at,
    }),
  );

const heartbeat = (published: number, extra: Record<string, unknown> = {}) =>
  Buffer.from(
    JSON.stringify({
      schema: "zfactory.agent-heartbeat",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      agentVersion: "0.3.0",
      uptimeS: 60,
      workers: 1,
      byState: { ONLINE: 1 },
      queue: { depth: 0, dropped: 0 },
      spooled: 0,
      published,
      at: new Date().toISOString(),
      ...extra,
    }),
  );

const plcState = (state: string, plcId = "plc-1") =>
  Buffer.from(
    JSON.stringify({
      schema: "zfactory.plc-state",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      plcId,
      name: "PLC-01",
      state,
      configVersion: 1,
      endpoint: "10.0.0.15:502",
      lastPollAt: "2026-10-07T10:00:00Z",
      lastError: state === "ONLINE" ? "" : "connection refused",
      reconnects: 2,
      at: new Date().toISOString(),
    }),
  );

const ROOT = "zfactory/plant-1/edge-1";

/** A broker that remembers what it was told, or fails like an unreachable one. */
class FakeBroker implements BrokerAdmin {
  clients = new Map<string, { identity: AgentBrokerIdentity; password: string; enabled: boolean }>();
  down = false;
  async ensureAgentClient(identity: AgentBrokerIdentity, password: string) {
    if (this.down) throw new BrokerUnavailableError("the broker did not answer");
    this.clients.set(identity.username, { identity, password, enabled: true });
  }
  async disableClient(username: string) {
    if (this.down) throw new BrokerUnavailableError("the broker did not answer");
    const client = this.clients.get(username);
    if (client) client.enabled = false;
  }
}

describeDb("agent connectivity and onboarding (TASK-902)", () => {
  let db: PrismaClient;
  let organizationId: string;
  let admin: Actor;
  let viewer: Actor;
  let agentId: string;
  let clock: Date;
  let ingestor: Ingestor;

  const actorOf = async (email: string, password: string) => {
    const signedIn = await authenticate(db, email, password);
    return (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
  };
  const agentRow = () => db.edgeAgent.findUniqueOrThrow({ where: { id: agentId } });
  const deliver = async (topic: string, payload: Buffer, retained = false) => {
    ingestor.handle(topic, payload, retained);
    await ingestor.idle();
  };

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    ({ organizationId } = await bootstrapAdmin(db, {
      organization: "Acme Water",
      slug: "acme-water",
      email: "admin@acme.example",
      name: "Ada Admin",
      password: "a long admin password",
    }));
    admin = await actorOf("admin@acme.example", "a long admin password");
    await addMember(db, admin, organizationId, {
      email: "vera@acme.example",
      name: "Vera",
      role: "VIEWER",
      password: "viewer password 1",
    });
    viewer = await actorOf("vera@acme.example", "viewer password 1");
    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    agentId = (await createAgent(db, admin, site.id, { agentKey: "edge-1", name: "Edge 1" })).id;
    await registerDeployment(db, admin, agentId, deploymentFile());
  });

  beforeEach(() => {
    clock = new Date("2026-10-07T10:00:00Z");
    ingestor = new Ingestor(db, { now: () => clock, agentCacheMs: 0, seenWriteMs: 5000 });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("projects online, then degraded and offline from status, heartbeat and silence", async () => {
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:59:59Z"));
    await deliver(`${ROOT}/agent/heartbeat`, heartbeat(10));
    let agent = await agentRow();
    expect(agent).toMatchObject({ status: "ONLINE", agentVersion: "0.3.0" });
    expect(agent.lastSeenAt).toEqual(clock);
    expect(agent.heartbeatJson).toMatchObject({ published: 10, workers: 1 });

    const view = (at: Date) => getAgent(db, viewer, agentId, { heartbeatMs: 10_000 }, at);
    expect((await view(new Date(clock.getTime() + 5_000))).connectivity.state).toBe("ONLINE");
    expect((await view(new Date(clock.getTime() + 30_000))).connectivity.state).toBe("DEGRADED");
    expect((await view(new Date(clock.getTime() + 61_000))).connectivity.state).toBe("OFFLINE");

    // A PLC worker that is not online degrades the agent; the PLC shows the agent's report.
    await deliver(`${ROOT}/state/plc-1`, plcState("RECONNECTING"));
    await deliver(`${ROOT}/agent/heartbeat`, heartbeat(11, { byState: { RECONNECTING: 1 } }));
    const degraded = await view(clock);
    expect(degraded.connectivity).toMatchObject({ state: "DEGRADED", reasons: ["1 of 1 PLC workers not online"] });
    expect(degraded.plcs[0]!.edge).toMatchObject({ state: "RECONNECTING", note: "connection refused", reconnects: 2 });

    agent = await agentRow();
    expect(agent.status).toBe("ONLINE");
  });

  it("records a status change once, however often it is delivered", async () => {
    await db.agentConnectionEvent.deleteMany();
    await db.edgeAgent.update({ where: { id: agentId }, data: { status: "UNKNOWN", lastSeenAt: null } });
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:00:00Z"));
    // QoS 1 redelivery and the retained copy after a reconnect: the same report.
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:00:00Z"));
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:00:00Z"), true);
    // The will: its time is the agent's start, older than the online report, and still wins.
    clock = new Date(clock.getTime() + 1000);
    await deliver(`${ROOT}/agent/status`, status("offline", "2026-10-07T08:59:00Z"));
    await deliver(`${ROOT}/agent/status`, status("offline", "2026-10-07T08:59:00Z"), true);
    const events = await db.agentConnectionEvent.findMany({ where: { edgeAgentId: agentId }, orderBy: { at: "asc" } });
    expect(events.map((event) => event.status)).toEqual(["ONLINE", "OFFLINE"]);
    expect((await agentRow()).status).toBe("OFFLINE");
    expect(ingestor.stats.transitions).toBe(2);

    // Heartbeats prove the agent is connected again, even if its online report was lost.
    clock = new Date(clock.getTime() + 1000);
    await deliver(`${ROOT}/agent/heartbeat`, heartbeat(12));
    expect((await agentRow()).status).toBe("ONLINE");
    expect(await db.agentConnectionEvent.count({ where: { edgeAgentId: agentId } })).toBe(3);
  });

  it("never counts a retained message as the agent being seen now", async () => {
    await db.edgeAgent.update({ where: { id: agentId }, data: { status: "UNKNOWN", lastSeenAt: null } });
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:00:00Z"), true);
    await deliver(`${ROOT}/state/plc-1`, plcState("ONLINE"), true);
    const agent = await agentRow();
    expect(agent.status).toBe("ONLINE");
    expect(agent.lastSeenAt).toBeNull();
    expect((await getAgent(db, viewer, agentId, undefined, clock)).connectivity.state).toBe("OFFLINE");
  });

  it("marks a PLC the agent cleared as removed, and ignores PLCs it does not know", async () => {
    await deliver(`${ROOT}/state/plc-1`, Buffer.alloc(0), true);
    expect((await db.plc.findFirstOrThrow({ where: { edgeAgentId: agentId } })).edgeState).toBe("REMOVED");
    await deliver(`${ROOT}/state/plc-9`, plcState("ONLINE", "plc-9"));
    expect(ingestor.stats.dropped["unknown-plc"]).toBe(1);
  });

  it("drops what is not an agent's own, well-formed report", async () => {
    await deliver("zfactory/plant-1/edge-1/agent/other", heartbeat(1));
    await deliver("zfactory/plant-1/ghost/agent/status", status("online", "2026-10-07T09:00:00Z", "ghost"));
    // The body names another agent than the topic.
    await deliver(`${ROOT}/agent/status`, status("online", "2026-10-07T09:00:00Z", "edge-2"));
    await deliver(`${ROOT}/agent/heartbeat`, Buffer.from("{not json"));
    await deliver(`${ROOT}/command/plc-1`, Buffer.from("{}"));
    await deliver(`${ROOT}/telemetry/plc-1`, Buffer.alloc((1 << 20) + 1));
    expect(ingestor.stats.dropped).toMatchObject({
      topic: 1,
      "unknown-agent": 1,
      identity: 1,
      malformed: 1,
      "not-ingested": 1,
      "too-large": 1,
    });
    expect(ingestor.stats.errors).toBe(0);
  });

  it("refreshes last seen from telemetry at most every few seconds", async () => {
    await deliver(`${ROOT}/telemetry/plc-1`, Buffer.from("{}"));
    const first = (await agentRow()).lastSeenAt;
    expect(first).toEqual(clock);
    clock = new Date(clock.getTime() + 2000);
    await deliver(`${ROOT}/telemetry/plc-1`, Buffer.from("{}"));
    expect((await agentRow()).lastSeenAt).toEqual(first);
    clock = new Date(clock.getTime() + 4000);
    await deliver(`${ROOT}/ack/plc-1`, Buffer.from("{}"));
    expect((await agentRow()).lastSeenAt).toEqual(clock);
  });

  it("coalesces heartbeats that queue up behind each other", async () => {
    for (let index = 0; index < 50; index += 1) ingestor.handle(`${ROOT}/agent/heartbeat`, heartbeat(100 + index));
    await ingestor.idle();
    expect((await agentRow()).heartbeatJson).toMatchObject({ published: 149 });
    expect(ingestor.stats.coalesced).toBeGreaterThan(0);
  });

  it("lets only admins issue credentials, shows the password once and never stores it", async () => {
    const broker = new FakeBroker();
    await expect(issueAgentCredentials(db, broker, viewer, agentId)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(issueAgentCredentials(db, null, admin, agentId)).rejects.toMatchObject({ code: "UNAVAILABLE" });

    const issued = await issueAgentCredentials(db, broker, admin, agentId);
    expect(issued).toMatchObject({
      username: "agent:plant-1:edge-1",
      clientId: "zfactory-agent-plant-1-edge-1",
      topicRoot: ROOT,
      rotated: false,
    });
    expect(issued.password).toMatch(/^[A-Za-z0-9_-]{32}$/);
    expect(broker.clients.get(issued.username)?.password).toBe(issued.password);

    const stored = JSON.stringify(await agentRow());
    const audited = JSON.stringify(await listAudit(db, admin, organizationId));
    expect(stored).not.toContain(issued.password);
    expect(audited).not.toContain(issued.password);
    expect(audited).toContain("AGENT_CREDENTIALS_ISSUED");

    const rotated = await issueAgentCredentials(db, broker, admin, agentId);
    expect(rotated.rotated).toBe(true);
    expect(rotated.password).not.toBe(issued.password);
    expect(broker.clients.get(issued.username)?.password).toBe(rotated.password);
    expect((await getAgent(db, admin, agentId)).credentials.state).toBe("ISSUED");
  });

  it("changes nothing when the broker cannot be reached", async () => {
    const broker = new FakeBroker();
    broker.down = true;
    const before = await agentRow();
    await expect(issueAgentCredentials(db, broker, admin, agentId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(revokeAgentCredentials(db, broker, admin, agentId)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    expect(await agentRow()).toEqual(before);
  });

  it("revokes: the broker client is disabled and the agent's messages are dropped", async () => {
    const broker = new FakeBroker();
    await issueAgentCredentials(db, broker, admin, agentId);
    await revokeAgentCredentials(db, broker, admin, agentId);
    expect(broker.clients.get("agent:plant-1:edge-1")?.enabled).toBe(false);
    const view = await getAgent(db, admin, agentId);
    expect(view.credentials.state).toBe("REVOKED");
    expect(view.connectivity).toMatchObject({ state: "OFFLINE", reasons: ["its broker credentials are revoked"] });
    await deliver(`${ROOT}/agent/heartbeat`, heartbeat(1));
    expect(ingestor.stats.dropped.revoked).toBe(1);
    await expect(revokeAgentCredentials(db, broker, admin, agentId)).rejects.toMatchObject({ code: "CONFLICT" });
    // Issuing again after a revocation is a fresh issue, not a rotation.
    expect((await issueAgentCredentials(db, broker, admin, agentId)).rotated).toBe(false);
  });

  it("refuses an agent whose client id another agent already uses", async () => {
    const siteA = await createSite(db, admin, organizationId, { siteKey: "a-b", name: "A-B" });
    const siteB = await createSite(db, admin, organizationId, { siteKey: "a", name: "A" });
    const first = await createAgent(db, admin, siteA.id, { agentKey: "c", name: "C" });
    const second = await createAgent(db, admin, siteB.id, { agentKey: "b-c", name: "B-C" });
    const broker = new FakeBroker();
    await issueAgentCredentials(db, broker, admin, first.id);
    await expect(issueAgentCredentials(db, broker, admin, second.id)).rejects.toMatchObject({
      code: "CONFLICT",
      details: { rule: "client-id" },
    });
  });
});
