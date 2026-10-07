import { type ChildProcess, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import mqtt, { type MqttClient } from "mqtt";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { MqttRuntime } from "@/lib/mqtt/runtime";
import { issueAgentCredentials, revokeAgentCredentials } from "@/lib/services/onboarding-service";
import { createAgent, createSite, getAgent, registerDeployment } from "@/lib/services/site-service";
import { actorForSession, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { agentBinary, docker, freePort, startBroker, until, withBroker } from "./broker-harness";
import { deploymentFile, openTestDb, resetDb } from "./harness";

/**
 * Web Factory against a real Mosquitto with Dynamic Security (TASK-902): onboarding,
 * per-agent topic authorization, status projection, a broker restart, the will and
 * revocation. Needs Docker (WEB_FACTORY_TEST_DOCKER=1 or TEST_DOCKER=1) and the test
 * database; with AGENT_BIN (the built zfactory-agent) the real agent connects too.
 */
const describeBroker = withBroker ? describe : describe.skip;

describeBroker("Web Factory and agents through Mosquitto Dynamic Security (TASK-902)", () => {
  let db: PrismaClient;
  let admin: Actor;
  let container = "";
  let url = "";
  let work = "";
  let runtime: MqttRuntime;
  let agentId: string;
  let otherAgentId: string;
  let password = "";
  const clients: MqttClient[] = [];
  let agentProcess: ChildProcess | undefined;

  const agentRow = (id = agentId) => db.edgeAgent.findUniqueOrThrow({ where: { id } });
  const connectAgent = (options: { password?: string; clientId?: string; will?: boolean } = {}) =>
    mqtt.connectAsync(url, {
      username: "agent:plant-1:edge-1",
      password: options.password ?? password,
      clientId: options.clientId ?? "zfactory-agent-plant-1-edge-1",
      protocolVersion: 5,
      reconnectPeriod: 0,
      connectTimeout: 5000,
      will:
        options.will === false
          ? undefined
          : {
              topic: "zfactory/plant-1/edge-1/agent/status",
              payload: Buffer.from(statusBody("offline")),
              qos: 1,
              retain: true,
            },
    });
  const statusBody = (status: "online" | "offline") =>
    JSON.stringify({
      schema: "zfactory.agent-status",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      status,
      agentVersion: "test",
      at: new Date().toISOString(),
    });
  const heartbeatBody = () =>
    JSON.stringify({
      schema: "zfactory.agent-heartbeat",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      agentVersion: "test",
      uptimeS: 1,
      workers: 1,
      byState: { ONLINE: 1 },
      queue: { depth: 0, dropped: 0 },
      spooled: 0,
      published: 0,
      at: new Date().toISOString(),
    });

  beforeAll(async () => {
    db = openTestDb();
    await resetDb(db);
    const { organizationId } = await bootstrapAdmin(db, {
      organization: "Acme Water",
      slug: "acme-water",
      email: "admin@acme.example",
      name: "Ada Admin",
      password: "a long admin password",
    });
    const signedIn = await authenticate(db, "admin@acme.example", "a long admin password");
    admin = (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    agentId = (await createAgent(db, admin, site.id, { agentKey: "edge-1", name: "Edge 1" })).id;
    otherAgentId = (await createAgent(db, admin, site.id, { agentKey: "edge-2", name: "Edge 2" })).id;
    await registerDeployment(db, admin, agentId, deploymentFile());

    work = mkdtempSync(join(tmpdir(), "web-factory-broker-"));
    const broker = await startBroker(work, "broker");
    container = broker.container;
    url = broker.url;
    runtime = new MqttRuntime(
      { url, username: "admin", passwordFile: broker.passwordFile, clientId: "web-factory-test" },
      db,
      () => {},
      { agentCacheMs: 0 },
    );
    await until("Web Factory to connect", () => runtime.status().connected || undefined, 20_000);
  }, 60_000);

  afterAll(async () => {
    agentProcess?.kill("SIGKILL");
    for (const client of clients) client.end(true);
    await runtime?.stop();
    if (container) docker("rm", "-f", container);
    if (work) rmSync(work, { recursive: true, force: true });
    await db?.$disconnect();
  });

  it("onboards an agent: it connects with its own credentials only", async () => {
    const issued = await issueAgentCredentials(db, runtime.dynsec, admin, agentId);
    password = issued.password;
    const agent = await connectAgent();
    clients.push(agent);
    expect(agent.connected).toBe(true);

    await expect(connectAgent({ password: "wrong" })).rejects.toMatchObject({ code: 135 });
    // The client is bound to the agent's client id.
    await expect(connectAgent({ clientId: "someone-else" })).rejects.toThrow();
  });

  it("projects the agent online from what it publishes", async () => {
    const agent = clients[0]!;
    await agent.publishAsync("zfactory/plant-1/edge-1/agent/status", statusBody("online"), { qos: 1, retain: true });
    await agent.publishAsync("zfactory/plant-1/edge-1/agent/heartbeat", heartbeatBody(), { qos: 0 });
    await until("the agent to be online", async () => {
      const view = await getAgent(db, admin, agentId);
      return view.connectivity.state === "ONLINE" ? view : undefined;
    });
    expect((await agentRow()).agentVersion).toBe("test");
  });

  it("refuses every topic outside the agent's own", async () => {
    const agent = clients[0]!;
    const before = runtime.status().ingest.received;
    await expect(
      agent.publishAsync("zfactory/plant-1/edge-2/agent/status", statusBody("online"), { qos: 1 }),
    ).rejects.toMatchObject({ code: 135 });
    await expect(agent.publishAsync("zfactory/plant-1/edge-1/command/plc-1", "{}", { qos: 1 })).rejects.toMatchObject({
      code: 135,
    });
    for (const topic of ["zfactory/plant-1/edge-2/command/+", "zfactory/#", "$CONTROL/dynamic-security/v1/response"]) {
      await expect(agent.subscribeAsync(topic, { qos: 1 })).rejects.toThrow(/Not authorized/);
    }
    await expect(agent.subscribeAsync("zfactory/plant-1/edge-1/command/+", { qos: 1 })).resolves.toBeDefined();
    // Nothing reached Web Factory, and the other agent is untouched.
    await new Promise((done) => setTimeout(done, 300));
    expect(runtime.status().ingest.received).toBe(before);
    expect((await agentRow(otherAgentId)).status).toBe("UNKNOWN");
  });

  it("replays retained state on reconnecting without duplicating it or faking a sign of life", async () => {
    const agent = clients[0]!;
    await agent.publishAsync("zfactory/plant-1/edge-1/agent/status", statusBody("online"), { qos: 1, retain: true });
    await new Promise((done) => setTimeout(done, 300));
    const events = await db.agentConnectionEvent.count({ where: { edgeAgentId: agentId } });
    const seen = (await agentRow()).lastSeenAt;
    const { connects, ingest } = runtime.status();
    const received = ingest.received;
    // Web Factory loses its connection (the agent keeps its own).
    runtime.client.stream.destroy();
    await until(
      "Web Factory to reconnect",
      () => (runtime.status().connects > connects && runtime.status().connected) || undefined,
    );
    await until("the retained status", () => runtime.status().ingest.received > received || undefined);
    await new Promise((done) => setTimeout(done, 300));
    expect(await db.agentConnectionEvent.count({ where: { edgeAgentId: agentId } })).toBe(events);
    expect((await agentRow()).lastSeenAt).toEqual(seen);
    expect((await agentRow()).status).toBe("ONLINE");
    expect(runtime.status().ingest.errors).toBe(0);
  }, 30_000);

  it("survives a broker restart: Web Factory reconnects and the agent's client is kept", async () => {
    const connects = runtime.status().connects;
    docker("restart", "-t", "1", container);
    await until(
      "Web Factory to reconnect",
      () => (runtime.status().connects > connects && runtime.status().connected) || undefined,
      30_000,
    );
    expect(runtime.status().disconnects).toBeGreaterThanOrEqual(2);
    // The broker's persisted Dynamic Security state still lets the agent in.
    const again = await until("the agent to reconnect", () => connectAgent());
    clients.push(again);
    await again.publishAsync("zfactory/plant-1/edge-1/agent/heartbeat", heartbeatBody(), { qos: 0 });
    await until("the agent to be online", async () => {
      const view = await getAgent(db, admin, agentId);
      return view.connectivity.state === "ONLINE" ? true : undefined;
    });
    expect(runtime.status().ingest.errors).toBe(0);
  }, 60_000);

  it("projects offline from the will when the agent drops off", async () => {
    const agent = clients[clients.length - 1]!;
    await agent.publishAsync("zfactory/plant-1/edge-1/agent/status", statusBody("online"), { qos: 1, retain: true });
    await until("online again", async () => ((await agentRow()).status === "ONLINE" ? true : undefined));
    // Gone without a word: the broker publishes the will.
    agent.stream.destroy();
    await until("the will", async () => ((await agentRow()).status === "OFFLINE" ? true : undefined));
    const events = await db.agentConnectionEvent.findMany({ where: { edgeAgentId: agentId }, orderBy: { at: "desc" } });
    expect(events[0]!.status).toBe("OFFLINE");
  }, 30_000);

  it.skipIf(!agentBinary)(
    "carries the real Thin Client Agent with issued credentials",
    async () => {
      const edge = mkdtempSync(join(work, "agent-"));
      writeFileSync(join(edge, "mqtt-password"), `${password}\n`, { mode: 0o600 });
      const health = await freePort();
      agentProcess = spawn(
        agentBinary!,
        [
          "-dir",
          edge,
          "-health",
          `127.0.0.1:${health}`,
          "-mqtt-url",
          url,
          "-site-id",
          "plant-1",
          "-agent-id",
          "edge-1",
          "-mqtt-username",
          "agent:plant-1:edge-1",
          "-mqtt-password-file",
          join(edge, "mqtt-password"),
          "-heartbeat",
          "1s",
        ],
        { stdio: "ignore" },
      );
      const view = await until(
        "the agent's heartbeat",
        async () => {
          const current = await getAgent(db, admin, agentId);
          return current.connectivity.state === "ONLINE" && current.agent.lastHeartbeatAt ? current : undefined;
        },
        20_000,
      );
      expect(view.agent.agentVersion).toBeTruthy();
      agentProcess.kill("SIGTERM");
      await until("the agent's goodbye", async () => ((await agentRow()).status === "OFFLINE" ? true : undefined));
      agentProcess = undefined;
    },
    40_000,
  );

  it("revokes: the agent is disconnected and cannot sign in again", async () => {
    const agent = await connectAgent({ will: false });
    clients.push(agent);
    const closed = new Promise<void>((done) => agent.once("close", () => done()));
    await revokeAgentCredentials(db, runtime.dynsec, admin, agentId);
    await closed;
    await expect(connectAgent()).rejects.toMatchObject({ code: 135 });
    expect((await getAgent(db, admin, agentId)).connectivity.state).toBe("OFFLINE");
  }, 30_000);
});
