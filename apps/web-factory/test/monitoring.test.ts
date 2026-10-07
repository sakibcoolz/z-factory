import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import { sweepAlarms } from "@/lib/alarms/engine";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { acknowledgeAlarm, listAlarms } from "@/lib/services/alarm-service";
import { liveView, parseScope } from "@/lib/services/live-service";
import { createAgent, createSite, getFactory, getModule, registerDeployment } from "@/lib/services/site-service";
import { actorForSession, addMember, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { PostgresTelemetryStore } from "@/lib/telemetry/store";
import { deploymentFile, mapping, openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;

// The live route reads the session through Auth.js; the test decides who is signed in.
const session = vi.hoisted(() => ({ current: null as { uid: string; sv: number } | null }));
vi.mock("@/auth", () => ({ auth: async () => session.current }));

describeDb("monitoring: alarms, live views and navigation (TASK-904)", () => {
  let db: PrismaClient;
  let admin: Actor;
  let operator: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let organizationId: string;
  let siteId: string;
  let agentId: string;
  let plcId: string;
  let store: PostgresTelemetryStore;

  const actorOf = async (email: string, password: string) => {
    const signedIn = await authenticate(db, email, password);
    return (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
  };
  const setAlarmTag = async (value: boolean, at = new Date()) => {
    await store.write([
      {
        plcId,
        at,
        receivedAt: at,
        configVersion: 1,
        replayed: false,
        values: [{ tag: "t-overheat", quality: "GOOD", num: null, bool: value }],
      },
    ]);
  };
  const active = () => db.alarm.findMany({ where: { activeKey: { not: null } }, orderBy: { source: "asc" } });

  beforeAll(async () => {
    db = openTestDb();
    store = new PostgresTelemetryStore(db);
    await resetDb(db);
    ({ organizationId } = await bootstrapAdmin(db, {
      organization: "Acme Water",
      slug: "acme-water",
      email: "admin@acme.example",
      name: "Ada Admin",
      password: "a long admin password",
    }));
    admin = await actorOf("admin@acme.example", "a long admin password");
    for (const [email, role] of [
      ["olli@acme.example", "OPERATOR"],
      ["vera@acme.example", "VIEWER"],
    ] as const) {
      await addMember(db, admin, organizationId, { email, name: email, role, password: "member password 1" });
    }
    operator = await actorOf("olli@acme.example", "member password 1");
    viewer = await actorOf("vera@acme.example", "member password 1");
    const other = await db.organization.create({ data: { name: "Other Co", slug: "other-co" } });
    const stranger = await db.user.create({ data: { email: "o@other.example", name: "O", passwordHash: "x" } });
    await db.membership.create({ data: { organizationId: other.id, userId: stranger.id, role: "ADMIN" } });
    outsider = { userId: stranger.id, email: stranger.email, name: stranger.name };

    siteId = (await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" })).id;
    agentId = (await createAgent(db, admin, siteId, { agentKey: "edge-1", name: "Edge 1" })).id;
    await registerDeployment(
      db,
      admin,
      agentId,
      deploymentFile({
        mappings: [
          mapping("t-speed", "Speed", "READ", "PROCESS_VALUE", "PROGRAM_OUTPUT", "INT16", "HOLDING_REGISTER", 100),
          mapping("t-overheat", "Overheat", "READ", "ALARM", "PROGRAM_OUTPUT", "BOOL", "COIL", 8200),
        ],
      }),
    );
    plcId = (await db.plc.findFirstOrThrow()).id;
  });

  beforeEach(async () => {
    await db.alarm.deleteMany();
    await db.$executeRawUnsafe('TRUNCATE telemetry.batch, telemetry.sample, "TagLatest", "PlcEvent"');
    await db.edgeAgent.update({
      where: { id: agentId },
      data: { status: "ONLINE", lastSeenAt: new Date(), heartbeatJson: { workers: 1, byState: { ONLINE: 1 } } },
    });
    await db.plc.update({ where: { id: plcId }, data: { edgeState: "ONLINE", edgeLastError: null } });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("raises an alarm while a PLC alarm tag is true and clears it when it is false", async () => {
    await setAlarmTag(true);
    expect(await sweepAlarms(db)).toEqual({ raised: 1, cleared: 0, updated: 0 });
    // Sweeping again changes nothing.
    expect(await sweepAlarms(db)).toEqual({ raised: 0, cleared: 0, updated: 0 });
    const [alarm] = await active();
    expect(alarm).toMatchObject({
      source: "PLC_TAG",
      severity: "HIGH",
      subject: "t-overheat",
      message: "Overheat on PLC-01",
    });

    await setAlarmTag(false, new Date(Date.now() + 1000));
    expect(await sweepAlarms(db)).toEqual({ raised: 0, cleared: 1, updated: 0 });
    const cleared = await db.alarm.findUniqueOrThrow({ where: { id: alarm!.id } });
    expect(cleared.activeKey).toBeNull();
    expect(cleared.clearedAt).not.toBeNull();
    // Raised again later: a new alarm, the old one stays in the history.
    await setAlarmTag(true, new Date(Date.now() + 2000));
    await sweepAlarms(db);
    expect(await db.alarm.count()).toBe(2);
  });

  it("keeps one active alarm per condition when sweeps run at once", async () => {
    await setAlarmTag(true);
    await Promise.all([sweepAlarms(db), sweepAlarms(db), sweepAlarms(db)]);
    expect(await active()).toHaveLength(1);
  });

  it("raises connection alarms, and leaves them alone while connectivity cannot be judged", async () => {
    await db.plc.update({ where: { id: plcId }, data: { edgeState: "DISCONNECTED", edgeLastError: "i/o timeout" } });
    await sweepAlarms(db);
    expect((await active()).map((alarm) => [alarm.source, alarm.severity])).toEqual([["PLC_CONNECTION", "HIGH"]]);

    // The agent goes silent: its alarm replaces the PLC's.
    await db.edgeAgent.update({ where: { id: agentId }, data: { lastSeenAt: new Date(Date.now() - 120_000) } });
    await sweepAlarms(db);
    expect((await active()).map((alarm) => alarm.source)).toEqual(["AGENT_CONNECTION"]);

    // Web Factory cannot judge (e.g. off the broker): the agent alarm stays.
    await db.edgeAgent.update({ where: { id: agentId }, data: { lastSeenAt: new Date() } });
    expect(await sweepAlarms(db, { judgeConnectivity: false })).toEqual({ raised: 0, cleared: 0, updated: 0 });
    expect(await active()).toHaveLength(1);
    // Judged again: the agent is back, its alarm clears and the PLC's returns.
    await sweepAlarms(db);
    expect((await active()).map((alarm) => alarm.source)).toEqual(["PLC_CONNECTION"]);
  });

  it("lets operators and admins acknowledge, once, with an audit record; viewers cannot", async () => {
    await setAlarmTag(true);
    await sweepAlarms(db);
    const [alarm] = await active();
    await expect(acknowledgeAlarm(db, viewer, alarm!.id)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(acknowledgeAlarm(db, outsider, alarm!.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await acknowledgeAlarm(db, operator, alarm!.id)).changed).toBe(true);
    expect((await acknowledgeAlarm(db, admin, alarm!.id)).changed).toBe(false);
    expect(await db.auditEvent.count({ where: { action: "ALARM_ACKNOWLEDGED", subjectId: alarm!.id } })).toBe(1);

    // Acknowledged and still active: listed; acknowledged and cleared: only in the history.
    let listed = await listAlarms(db, viewer, organizationId, { state: "active" });
    expect(listed.alarms[0]).toMatchObject({ active: true, acknowledgedBy: "olli@acme.example" });
    await setAlarmTag(false, new Date(Date.now() + 1000));
    await sweepAlarms(db);
    listed = await listAlarms(db, viewer, organizationId, { state: "active" });
    expect(listed.alarms).toHaveLength(0);
    const history = await listAlarms(db, viewer, organizationId, { state: "history", plcId });
    expect(history.alarms).toHaveLength(1);
    await expect(listAlarms(db, outsider, organizationId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(listAlarms(db, viewer, organizationId, { plcId: "x" })).rejects.toMatchObject({ code: "VALIDATION" });
  });

  it("builds the live view of each scope for members only", async () => {
    await setAlarmTag(true);
    await sweepAlarms(db);
    const plc = await liveView(db, viewer, { kind: "plc", id: plcId });
    expect("plc" in plc && plc.plc.tags.find((tag) => tag.tag === "t-overheat")).toMatchObject({ value: true });
    expect(plc.alarms).toHaveLength(1);
    const agent = await liveView(db, viewer, { kind: "agent", id: agentId });
    expect("agent" in agent && agent.agent.connectivity.state).toBe("ONLINE");
    const site = await liveView(db, viewer, { kind: "site", id: siteId });
    expect("agents" in site && site.agents.map((entry) => entry.name)).toEqual(["Edge 1"]);
    const org = await liveView(db, viewer, { kind: "org", id: organizationId });
    expect(org.alarms).toHaveLength(1);
    for (const scope of [
      { kind: "plc" as const, id: plcId },
      { kind: "agent" as const, id: agentId },
      { kind: "site" as const, id: siteId },
      { kind: "org" as const, id: organizationId },
    ]) {
      await expect(liveView(db, outsider, scope)).rejects.toMatchObject({ code: "NOT_FOUND" });
    }
    expect(parseScope(`plc:${plcId}`)).toEqual({ kind: "plc", id: plcId });
    expect(() => parseScope("plc:../x")).toThrow();
    expect(() => parseScope(null)).toThrow();
  });

  it("navigates factory and module pages within the tenant", async () => {
    const factory = await db.factory.findFirstOrThrow();
    const processModule = await db.module.findFirstOrThrow();
    expect((await getFactory(db, viewer, factory.id)).factory.plcs.map((plc) => plc.id)).toEqual([plcId]);
    expect((await getModule(db, viewer, processModule.id)).module.plcs.map((entry) => entry.plc.id)).toEqual([plcId]);
    await expect(getFactory(db, outsider, factory.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getModule(db, outsider, processModule.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("streams a new view when it changes, and refuses who may not see it", async () => {
    // The route takes its database from getDb(): the test database here.
    (globalThis as { webFactoryDb?: PrismaClient }).webFactoryDb = db;
    const { GET } = await import("@/app/api/v1/live/route");
    session.current = null;
    expect((await GET(new Request(`http://test/api/v1/live?scope=plc:${plcId}`))).status).toBe(401);

    const vera = await db.user.findUniqueOrThrow({ where: { email: "vera@acme.example" } });
    session.current = { uid: vera.id, sv: vera.sessionVersion };
    expect((await GET(new Request("http://test/api/v1/live?scope=nonsense"))).status).toBe(400);
    const foreign = await db.organization.findFirstOrThrow({ where: { slug: "other-co" } });
    expect((await GET(new Request(`http://test/api/v1/live?scope=org:${foreign.id}`))).status).toBe(404);

    const abort = new AbortController();
    const response = await GET(new Request(`http://test/api/v1/live?scope=plc:${plcId}`, { signal: abort.signal }));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    const nextView = async () => {
      for (;;) {
        const events = text.split("\n\n");
        const index = events.findIndex((event) => event.startsWith("event: view") || event.includes("\nevent: view"));
        if (index >= 0) {
          const event = events[index]!;
          text = events.slice(index + 1).join("\n\n");
          return JSON.parse(event.slice(event.indexOf("data: ") + 6)) as {
            plc: { tags: Array<{ tag: string; value: unknown }> };
          };
        }
        const { value, done } = await reader.read();
        if (done) throw new Error("the stream ended");
        text += decoder.decode(value);
      }
    };
    const first = await nextView();
    expect(first.plc.tags.find((tag) => tag.tag === "t-speed")?.value).toBeNull();
    // A new value arrives: the stream sends the changed view without being asked.
    await store.write([
      {
        plcId,
        at: new Date(),
        receivedAt: new Date(),
        configVersion: 1,
        replayed: false,
        values: [{ tag: "t-speed", quality: "GOOD", num: 42, bool: null }],
      },
    ]);
    const second = await nextView();
    expect(second.plc.tags.find((tag) => tag.tag === "t-speed")?.value).toBe(42);
    abort.abort();
    await reader.cancel();
  }, 20_000);
});
