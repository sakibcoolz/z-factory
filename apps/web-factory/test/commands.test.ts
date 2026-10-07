import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { Ingestor } from "@/lib/mqtt/ingest";
import { applyAck, expireCommands, getCommand, issueCommand, listCommands } from "@/lib/services/command-service";
import { createAgent, createSite, registerDeployment } from "@/lib/services/site-service";
import { actorForSession, addMember, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { PostgresTelemetryStore } from "@/lib/telemetry/store";
import { deploymentFile, openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;

describeDb("commands and setpoints (TASK-905)", () => {
  let db: PrismaClient;
  let operator: Actor;
  let viewer: Actor;
  let outsider: Actor;
  let organizationId: string;
  let agentId: string;
  let plcId: string;
  let published: Array<{ topic: string; body: Record<string, unknown> }>;
  let brokerDown: boolean;
  const publish = async (topic: string, payload: string) => {
    if (brokerDown) throw new Error("not connected to the broker");
    published.push({ topic, body: JSON.parse(payload) as Record<string, unknown> });
  };
  let keys = 0;
  const key = () => `request-key-${(keys += 1)}`;
  const send = (actor: Actor, tag: string, value: unknown, requestKey = key()) =>
    issueCommand(db, publish, actor, plcId, { tag, value, requestKey });
  const ack = (commandId: string, status: string, extra: Record<string, unknown> = {}) => ({
    schema: "zfactory.command-ack" as const,
    version: 1 as const,
    commandId,
    plcId: "plc-1",
    status: status as "ACCEPTED",
    at: new Date(),
    ...extra,
  });

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
    const admin = (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
    for (const [email, role] of [
      ["olli@acme.example", "OPERATOR"],
      ["vera@acme.example", "VIEWER"],
    ] as const) {
      await addMember(db, admin, organizationId, {
        email,
        name: email.split("@")[0]!,
        role,
        password: "member password 1",
      });
    }
    const actorOf = async (email: string) => {
      const session = await authenticate(db, email, "member password 1");
      return (await actorForSession(db, session?.userId, session?.sessionVersion))!;
    };
    operator = await actorOf("olli@acme.example");
    viewer = await actorOf("vera@acme.example");
    const other = await db.organization.create({ data: { name: "Other", slug: "other" } });
    const stranger = await db.user.create({ data: { email: "o@other.example", name: "O", passwordHash: "x" } });
    await db.membership.create({ data: { organizationId: other.id, userId: stranger.id, role: "ADMIN" } });
    outsider = { userId: stranger.id, email: stranger.email, name: stranger.name };

    const site = await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" });
    agentId = (await createAgent(db, admin, site.id, { agentKey: "edge-1", name: "Edge 1" })).id;
    await registerDeployment(db, admin, agentId, deploymentFile({ version: 3 }));
    plcId = (await db.plc.findFirstOrThrow()).id;
  });

  beforeEach(async () => {
    published = [];
    brokerDown = false;
    await db.command.deleteMany();
    await db.auditEvent.deleteMany({ where: { action: { startsWith: "COMMAND_" } } });
    await db.edgeAgent.update({
      where: { id: agentId },
      data: {
        brokerUsername: "agent:plant-1:edge-1",
        credentialIssuedAt: new Date(),
        credentialRevokedAt: null,
        status: "ONLINE",
        lastSeenAt: new Date(),
        heartbeatJson: { workers: 1, byState: { ONLINE: 1 } },
      },
    });
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("publishes a checked setpoint to the agent's command topic with the exact envelope", async () => {
    const { command } = await send(operator, "t-speed", 42.5);
    expect(command).toMatchObject({ status: "PUBLISHED", valueNum: 42.5, configVersion: 3 });
    expect(published).toHaveLength(1);
    expect(published[0]!.topic).toBe("zfactory/plant-1/edge-1/command/plc-1");
    expect(published[0]!.body).toMatchObject({
      schema: "zfactory.command",
      version: 1,
      commandId: command.id,
      plcId: "plc-1",
      mappingId: "t-speed",
      value: 42.5,
      configVersion: 3,
      requestedBy: operator.userId,
    });
    const body = published[0]!.body as { issuedAt: string; expiresAt: string };
    expect(new Date(body.expiresAt).getTime() - new Date(body.issuedAt).getTime()).toBe(60_000);
    const audited = await db.auditEvent.findFirstOrThrow({
      where: { action: "COMMAND_REQUESTED", subjectId: command.id },
    });
    expect(audited.actorUserId).toBe(operator.userId);
    expect(audited.detailJson).toMatchObject({ tag: "t-speed", value: 42.5 });
    // Booleans for command bits.
    expect((await send(operator, "t-start", true)).command.valueBool).toBe(true);
  });

  it("refuses before publishing, and records and audits every refusal", async () => {
    await expect(send(viewer, "t-start", true)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await db.auditEvent.count({ where: { action: "COMMAND_REFUSED", actorUserId: viewer.userId } })).toBe(1);
    await expect(send(outsider, "t-start", true)).rejects.toMatchObject({ code: "NOT_FOUND" });

    const cases: Array<[string, unknown, string]> = [
      ["t-running", true, "not-writable"],
      ["t-ghost", true, "unknown-tag"],
      ["t-speed", 5000, "value-range"],
      ["t-speed", "fast", "command-input"],
      ["t-start", 1, "value-type"],
    ];
    for (const [tag, value, rule] of cases) {
      if (rule === "command-input") {
        await expect(send(operator, tag, value)).rejects.toMatchObject({ code: "VALIDATION" });
        continue;
      }
      const { command } = await send(operator, tag, value);
      expect(command, `${tag}=${String(value)}`).toMatchObject({ status: "REJECTED", rule });
    }
    expect(published).toHaveLength(0);
    expect(await db.auditEvent.count({ where: { action: "COMMAND_REJECTED" } })).toBe(4);

    // An unreachable or revoked agent: the command would only expire.
    await db.edgeAgent.update({ where: { id: agentId }, data: { lastSeenAt: new Date(Date.now() - 600_000) } });
    expect((await send(operator, "t-start", true)).command).toMatchObject({
      status: "REJECTED",
      rule: "agent-offline",
    });
    await db.edgeAgent.update({
      where: { id: agentId },
      data: { lastSeenAt: new Date(), credentialRevokedAt: new Date() },
    });
    expect((await send(operator, "t-start", true)).command).toMatchObject({
      status: "REJECTED",
      rule: "agent-not-onboarded",
    });
    expect(published).toHaveLength(0);
  });

  it("is one command when the same form is sent twice, even at once", async () => {
    const first = await send(operator, "t-start", true, "same-form-key");
    const again = await send(operator, "t-start", true, "same-form-key");
    expect(again).toMatchObject({ repeated: true, command: { id: first.command.id } });
    const raced = await Promise.all([
      send(operator, "t-start", false, "raced-form-key"),
      send(operator, "t-start", false, "raced-form-key"),
    ]);
    expect(new Set(raced.map((result) => result.command.id)).size).toBe(1);
    expect(published).toHaveLength(2);
  });

  it("fails without touching the PLC when the broker cannot take it", async () => {
    brokerDown = true;
    const { command } = await send(operator, "t-start", true);
    expect(command).toMatchObject({ status: "FAILED", rule: "broker-unavailable", publishedAt: null });
    expect(command.reason).toContain("Nothing reached the PLC");
  });

  it("follows the agent's answers forward only, counts redeliveries, and times out", async () => {
    const { command } = await send(operator, "t-speed", 10);
    expect(await applyAck(db, agentId, "plc-1", ack(command.id, "ACCEPTED"))).toBe("applied");
    expect(await applyAck(db, agentId, "plc-1", ack(command.id, "APPLIED", { observed: 10 }))).toBe("applied");
    // A redelivered command is answered again by the agent, marked duplicate: counted, not applied.
    expect(await applyAck(db, agentId, "plc-1", ack(command.id, "APPLIED", { duplicate: true }))).toBe("duplicate");
    expect(await applyAck(db, agentId, "plc-1", ack(command.id, "FAILED"))).toBe("unchanged");
    let stored = await db.command.findUniqueOrThrow({ where: { id: command.id } });
    expect(stored).toMatchObject({ status: "APPLIED", observedJson: 10, duplicateAcks: 1 });
    expect(await db.auditEvent.count({ where: { action: "COMMAND_APPLIED", subjectId: command.id } })).toBe(1);

    // Another agent's or another PLC's answer, or an unknown id, is not applied.
    expect(await applyAck(db, "00000000-0000-7000-8000-000000000000", "plc-1", ack(command.id, "FAILED"))).toBe(
      "unknown-command",
    );
    expect(await applyAck(db, agentId, "plc-9", ack(command.id, "FAILED"))).toBe("unknown-command");
    expect(await applyAck(db, agentId, "plc-1", ack("forged", "APPLIED"))).toBe("unknown-command");

    // The edge refuses: its rule and reason are kept.
    const refused = (await send(operator, "t-speed", 20)).command;
    await applyAck(
      db,
      agentId,
      "plc-1",
      ack(refused.id, "REJECTED", { rule: "stale-config-version", reason: "the PLC runs 2" }),
    );
    expect(await db.command.findUniqueOrThrow({ where: { id: refused.id } })).toMatchObject({
      status: "REJECTED",
      rule: "stale-config-version",
    });

    // Accepted in time, then expired while waiting for the PLC (TASK-907): a final FAILED
    // with the agent's rule; the agent wrote nothing.
    const late = (await send(operator, "t-start", true)).command;
    await applyAck(db, agentId, "plc-1", ack(late.id, "ACCEPTED"));
    expect(
      await applyAck(
        db,
        agentId,
        "plc-1",
        ack(late.id, "FAILED", {
          rule: "command-expired",
          reason: "the command expired before it could be written; nothing was written",
        }),
      ),
    ).toBe("applied");
    expect(await db.command.findUniqueOrThrow({ where: { id: late.id } })).toMatchObject({
      status: "FAILED",
      rule: "command-expired",
      reason: "the command expired before it could be written; nothing was written",
    });
    expect(await db.auditEvent.count({ where: { action: "COMMAND_FAILED", subjectId: late.id } })).toBe(1);

    // No answer: timed out after expiry and grace; a late final answer is still taken.
    const silent = (await send(operator, "t-speed", 30)).command;
    expect(await expireCommands(db, new Date(Date.now() + 30_000))).toBe(0);
    expect(await expireCommands(db, new Date(Date.now() + 75_000))).toBe(1);
    expect(await db.command.findUniqueOrThrow({ where: { id: silent.id } })).toMatchObject({
      status: "TIMED_OUT",
      rule: "no-answer",
    });
    await applyAck(db, agentId, "plc-1", ack(silent.id, "APPLIED", { observed: 30 }));
    stored = await db.command.findUniqueOrThrow({ where: { id: silent.id } });
    expect(stored).toMatchObject({ status: "APPLIED", lateAnswer: true });
  });

  it("takes answers from the MQTT handler and shows telemetry confirming the value", async () => {
    const { command } = await send(operator, "t-speed", 12.5);
    const ingestor = new Ingestor(db, {
      agentCacheMs: 0,
      commands: { applyAck: (agent, plc, answer, at) => applyAck(db, agent, plc, answer, at) },
    });
    const deliver = async (payload: unknown) => {
      ingestor.handle("zfactory/plant-1/edge-1/ack/plc-1", Buffer.from(JSON.stringify(payload)));
      await ingestor.idle();
    };
    await deliver(ack(command.id, "ACCEPTED"));
    await deliver({ ...ack(command.id, "APPLIED", { observed: 12.5 }), at: new Date().toISOString() });
    await deliver({ nonsense: true });
    expect(ingestor.stats.acks).toMatchObject({ applied: 2 });
    expect(ingestor.stats.dropped.malformed).toBe(1);

    // The PLC's next poll shows the setpoint: confirmed.
    const store = new PostgresTelemetryStore(db);
    await store.write([
      {
        plcId,
        at: new Date(Date.now() + 200),
        receivedAt: new Date(),
        configVersion: 3,
        replayed: false,
        values: [{ tag: "t-speed", quality: "GOOD", num: 12.500000000000002, bool: null }],
      },
    ]);
    const view = await getCommand(db, viewer, command.id);
    expect(view).toMatchObject({ status: "APPLIED", observed: 12.5, requestedBy: "olli", value: 12.5 });
    expect(view.confirmedAt).not.toBeNull();
    const listed = await listCommands(db, viewer, plcId);
    expect(listed.commands[0]?.id).toBe(command.id);
    await expect(listCommands(db, outsider, plcId)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getCommand(db, outsider, command.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
