import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  createAgent,
  createSite,
  getAgent,
  getPlc,
  getSite,
  listAudit,
  registerDeployment,
} from "@/lib/services/site-service";
import { actorForSession, addMember, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { deploymentFile, mapping, openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;

describeDb("sites, agents and PLC registration from deployment files (TASK-901)", () => {
  let db: PrismaClient;
  let organizationId: string;
  let admin: Actor;
  let viewer: Actor;
  let siteId: string;
  let agentId: string;

  const actorOf = async (email: string, password: string) => {
    const signedIn = await authenticate(db, email, password);
    return (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
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
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("creates sites and agents whose ids are MQTT topic segments", async () => {
    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    siteId = site.id;
    await expect(createSite(db, admin, organizationId, { siteKey: "plant/#", name: "Bad" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    // Site ids are unique on the broker, across organizations too.
    const other = await db.organization.create({ data: { name: "Other", slug: "other" } });
    await db.membership.create({ data: { organizationId: other.id, userId: admin.userId, role: "ADMIN" } });
    await expect(createSite(db, admin, other.id, { siteKey: "plant-1", name: "Mine too" })).rejects.toMatchObject({
      details: { rule: "site-key" },
    });

    const agent = await createAgent(db, admin, siteId, { agentKey: "edge-1", name: "Edge gateway 1" });
    agentId = agent.id;
    await expect(createAgent(db, admin, siteId, { agentKey: "edge-1", name: "Again" })).rejects.toMatchObject({
      details: { rule: "agent-key" },
    });
    await expect(createAgent(db, viewer, siteId, { agentKey: "edge-2", name: "Nope" })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect((await getAgent(db, viewer, agentId)).topicRoot).toBe("zfactory/plant-1/edge-1");
  });

  it("registers a PLC from its deployment file: identity, tags, the writable allow-list and modules", async () => {
    const result = await registerDeployment(db, admin, agentId, deploymentFile({ version: 3 }));
    expect(result).toMatchObject({ created: true, unchanged: false });
    const { plc, connection } = await getPlc(db, viewer, result.plcId);
    expect(plc).toMatchObject({ externalPlcId: "plc-1", name: "PLC-01", configVersion: 3 });
    expect(plc.factory).toMatchObject({ externalFactoryId: "factory-1", name: "Pump House" });
    expect(connection).toMatchObject({ host: "10.0.0.15", port: 502 });
    expect(plc.mappings.map((m) => [m.name, m.access, m.min, m.max])).toEqual([
      ["Running", "READ", null, null],
      ["Speed_SP", "WRITE", -3276.8, 3276.7],
      ["Start_Cmd", "WRITE", null, null],
    ]);
    expect(plc.modules.map((entry) => entry.module.name)).toEqual(["PH-01"]);
    // A compact file of the same content is the same version.
    expect(await registerDeployment(db, admin, agentId, deploymentFile({ version: 3, pretty: false }))).toMatchObject({
      unchanged: true,
    });
    expect((await getSite(db, viewer, siteId)).agents[0]?.plcs.map((p) => p.name)).toEqual(["PLC-01"]);
  });

  it("refuses files that were changed, older or reused versions, and a PLC another agent runs", async () => {
    const refusal = async (text: string, actor = admin, agent = agentId) =>
      registerDeployment(db, actor, agent, text).then(
        () => "registered",
        (error: { details?: { rule?: string }; code?: string }) => error.details?.rule ?? error.code,
      );
    const tampered = deploymentFile({ version: 4 }).replace('"Running"', '"Running_Hacked"');
    expect(await refusal(tampered)).toBe("checksum");
    expect(await refusal("{not json")).toBe("json");
    expect(await refusal(JSON.stringify({ schema: "something.else" }))).toBe("schema");
    expect(
      await refusal(
        deploymentFile({
          version: 4,
          mappings: [mapping("t-run", "Running", "WRITE", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 8192)],
        }),
      ),
    ).toBe("mapping-write");
    expect(await refusal(deploymentFile({ version: 2 }))).toBe("stale-config");
    expect(await refusal(deploymentFile({ version: 3, plcName: "PLC-01 renamed" }))).toBe("config-version-reused");
    expect(await refusal(deploymentFile({ version: 9 }), viewer)).toBe("FORBIDDEN");

    const second = await createAgent(db, admin, siteId, { agentKey: "edge-2", name: "Edge gateway 2" });
    expect(await refusal(deploymentFile({ version: 5 }), admin, second.id)).toBe("plc-elsewhere");
    const otherSite = await createSite(db, admin, organizationId, { siteKey: "plant-2", name: "Plant 2" });
    const remote = await createAgent(db, admin, otherSite.id, { agentKey: "edge-1", name: "Remote" });
    expect(await refusal(deploymentFile({ plcId: "plc-9", version: 1 }), admin, remote.id)).toBe("factory-site");
  });

  it("updates a PLC to a newer version and records every change", async () => {
    const update = await registerDeployment(
      db,
      admin,
      agentId,
      deploymentFile({
        version: 4,
        mappings: [mapping("t-start", "Start_Cmd", "WRITE", "COMMAND", "EXTERNAL_COMMAND", "BOOL", "COIL", 800)],
        modules: [],
      }),
    );
    expect(update).toMatchObject({ created: false, unchanged: false });
    const { plc } = await getPlc(db, admin, update.plcId);
    expect(plc.configVersion).toBe(4);
    expect(plc.mappings.map((m) => m.name)).toEqual(["Start_Cmd"]);
    expect(plc.modules).toEqual([]);
    const actions = (await listAudit(db, admin, organizationId)).map((event) => event.action);
    expect(actions).toEqual(
      expect.arrayContaining(["PLC_UPDATED", "PLC_REGISTERED", "AGENT_REGISTERED", "SITE_CREATED", "MEMBER_ADDED"]),
    );
    const updated = (await listAudit(db, admin, organizationId)).find((event) => event.action === "PLC_UPDATED");
    expect(updated?.detailJson).toMatchObject({ configVersion: 4, from: 3, writable: 1 });
  });
});
