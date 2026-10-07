import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { MqttRuntime } from "@/lib/mqtt/runtime";
import { issueAgentCredentials } from "@/lib/services/onboarding-service";
import { createAgent, createSite, registerDeployment } from "@/lib/services/site-service";
import { getHistory, getLatest, getLatestInScope, getPlcEvents } from "@/lib/services/telemetry-service";
import { actorForSession, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { agentBinary, docker, freePort, startBroker, until, withBroker } from "./broker-harness";
import { deploymentFile, openTestDb, resetDb } from "./harness";
import { ModbusServer } from "./modbus-server";

/**
 * Telemetry end to end (TASK-903): two simulated PLCs (Modbus TCP servers), the real
 * Thin Client Agent polling them, a real Mosquitto with Dynamic Security, and Web Factory
 * storing what arrives. PLCs are added while the agent runs; one goes away; the broker
 * goes away and the agent's spool is replayed without a duplicate. Needs Docker, the test
 * database and AGENT_BIN.
 */
const describeE2E = withBroker && agentBinary ? describe : describe.skip;

const POLL_MS = 200;

describeE2E("telemetry from real agents into Web Factory (TASK-903)", () => {
  let db: PrismaClient;
  let admin: Actor;
  let organizationId: string;
  let agentId: string;
  let work = "";
  let edge = "";
  let container = "";
  let runtime: MqttRuntime;
  let agent: ChildProcess | undefined;
  const plcs = { a: new ModbusServer(), b: new ModbusServer() };
  const ports = { a: 0, b: 0 };
  const files: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const count = async (sql: string, ...args: unknown[]) =>
    Number((await db.$queryRawUnsafe<Array<{ n: bigint }>>(sql, ...args))[0]?.n ?? 0);
  const speedOf = async (plc: "a" | "b") =>
    (await getLatest(db, admin, ids[plc]!)).tags.find((tag) => tag.tag === "t-speed");

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
    const signedIn = await authenticate(db, "admin@acme.example", "a long admin password");
    admin = (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    agentId = (await createAgent(db, admin, site.id, { agentKey: "edge-1", name: "Edge 1" })).id;

    for (const plc of ["a", "b"] as const) {
      ports[plc] = await freePort();
      await plcs[plc].listen(ports[plc]);
      files[plc] = deploymentFile({
        plcId: `plc-${plc}`,
        plcName: `PLC-${plc.toUpperCase()}`,
        factoryId: "factory-1",
        host: "127.0.0.1",
        port: ports[plc],
        pollIntervalMs: POLL_MS,
      });
      await registerDeployment(db, admin, agentId, files[plc]);
      ids[plc] = (await db.plc.findFirstOrThrow({ where: { externalPlcId: `plc-${plc}` } })).id;
    }
    // Speed_SP is a holding register in tenths of Hz; Running a coil.
    plcs.a.registers.set(101, 125);
    plcs.a.coils.set(8192, true);
    plcs.b.registers.set(101, 300);

    work = mkdtempSync(join(tmpdir(), "web-factory-telemetry-"));
    const broker = await startBroker(work, "telemetry");
    container = broker.container;
    runtime = new MqttRuntime(
      { url: broker.url, username: "admin", passwordFile: broker.passwordFile, clientId: "web-factory-telemetry-test" },
      db,
      () => {},
      { agentCacheMs: 0 },
      { plcCacheMs: 0 },
    );
    await until("Web Factory to connect", () => runtime.status().connected || undefined, 20_000);

    const issued = await issueAgentCredentials(db, runtime.dynsec, admin, agentId);
    edge = join(work, "agent");
    mkdirSync(join(edge, "staging"), { recursive: true });
    writeFileSync(join(edge, "mqtt-password"), `${issued.password}\n`, { mode: 0o600 });
    const health = await freePort();
    agent = spawn(
      agentBinary!,
      [
        ...["-dir", edge, "-health", `127.0.0.1:${health}`, "-scan", "200ms", "-settle", "0s"],
        ...["-mqtt-url", broker.url, "-site-id", "plant-1", "-agent-id", "edge-1"],
        ...["-mqtt-username", issued.username, "-mqtt-password-file", join(edge, "mqtt-password"), "-heartbeat", "1s"],
      ],
      { stdio: "ignore" },
    );
  }, 60_000);

  afterAll(async () => {
    agent?.kill("SIGKILL");
    await runtime?.stop();
    if (container) docker("rm", "-f", container);
    await plcs.a.close();
    await plcs.b.close();
    if (work) rmSync(work, { recursive: true, force: true });
    await db?.$disconnect();
  });

  it("stores the polls of a PLC deployed to the running agent, with the latest value", async () => {
    writeFileSync(join(edge, "staging", "plc-a.json"), files.a!);
    const speed = await until(
      "PLC-A's speed",
      async () => {
        const tag = await speedOf("a");
        return tag?.value === 12.5 && tag.quality === "GOOD" ? tag : undefined;
      },
      20_000,
    );
    expect(speed).toMatchObject({ reportedQuality: "GOOD" });
    const running = (await getLatest(db, admin, ids.a!)).tags.find((tag) => tag.tag === "t-running");
    expect(running).toMatchObject({ value: true, quality: "GOOD" });

    // A new value on the PLC reaches the latest view and the history.
    plcs.a.registers.set(101, 250);
    await until("the new speed", async () => ((await speedOf("a"))?.value === 25 ? true : undefined));
    const history = await getHistory(db, runtime.telemetryStore, admin, ids.a!, { tag: "t-speed" });
    const values = "samples" in history ? history.samples.map((sample) => sample.value) : [];
    expect(values).toContain(12.5);
    expect(values.at(-1)).toBe(25);
    expect(runtime.status().telemetry.errors).toBe(0);
  }, 40_000);

  it("adds a second PLC while the agent runs", async () => {
    writeFileSync(join(edge, "staging", "plc-b.json"), files.b!);
    await until("PLC-B's speed", async () => ((await speedOf("b"))?.value === 30 ? true : undefined), 20_000);
    const latest = await getLatestInScope(db, admin, { agentId });
    expect(latest.plcs.map((plc) => [plc.name, plc.tags.find((tag) => tag.tag === "t-speed")?.value])).toEqual([
      ["PLC-A", 25],
      ["PLC-B", 30],
    ]);
  }, 40_000);

  it("shows a PLC that goes away as disconnected, with the change recorded", async () => {
    await plcs.a.close();
    await until("PLC-A disconnected", async () =>
      (await speedOf("a"))?.quality === "DISCONNECTED" ? true : undefined,
    );
    const events = await getPlcEvents(db, admin, ids.a!, { kind: "PLC_STATE" });
    expect(events.events[0]?.from).toBe("ONLINE");
    expect(["RECONNECTING", "DISCONNECTED"]).toContain(events.events[0]?.to);
    // PLC-B goes on.
    const before = await count("SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid", ids.b!);
    await until("more PLC-B polls", async () =>
      (await count("SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid", ids.b!)) > before + 3
        ? true
        : undefined,
    );
  }, 40_000);

  it("replays what the agent spooled during a broker outage, once", async () => {
    const plcB = ids.b!;
    const before = await count("SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid", plcB);
    docker("stop", "-t", "1", container);
    // The agent keeps polling and spools; PLC-B's value changes meanwhile.
    plcs.b.registers.set(101, 450);
    await new Promise((done) => setTimeout(done, 3_000));
    docker("start", container);
    await until("Web Factory to reconnect", () => runtime.status().connected || undefined, 30_000);
    await until(
      "replayed batches",
      async () =>
        (await count("SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid AND replayed", plcB)) >= 5 ||
        undefined,
      30_000,
    );
    await until("the new value", async () => ((await speedOf("b"))?.value === 45 ? true : undefined), 20_000);
    const after = await count("SELECT count(*) AS n FROM telemetry.batch WHERE plc_id = $1::uuid", plcB);
    // About one poll every 200 ms through the outage was kept, not lost.
    expect(after - before).toBeGreaterThanOrEqual(10);
    // Every batch is there once: as many samples per tag as batches.
    const samples = await count(
      "SELECT count(*) AS n FROM telemetry.sample WHERE plc_id = $1::uuid AND tag = 't-speed'",
      plcB,
    );
    expect(samples).toBe(after);
    const history = await getHistory(db, runtime.telemetryStore, admin, plcB, { tag: "t-speed", limit: "10000" });
    const times = "samples" in history ? history.samples.map((sample) => sample.at.getTime()) : [];
    expect(new Set(times).size).toBe(times.length);
    expect(runtime.status().telemetry.errors).toBe(0);
  }, 90_000);
});
