import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "@/lib/auth/actor";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { Ingestor } from "@/lib/mqtt/ingest";
import {
  getConnectionHistory,
  getHistory,
  getLatest,
  getLatestInScope,
  getPlcEvents,
} from "@/lib/services/telemetry-service";
import { createAgent, createSite, registerDeployment } from "@/lib/services/site-service";
import { actorForSession, authenticate, bootstrapAdmin } from "@/lib/services/user-service";
import { TelemetryPipeline } from "@/lib/telemetry/pipeline";
import { PostgresTelemetryStore, type ResolvedBatch, type TelemetryStore } from "@/lib/telemetry/store";
import { deploymentFile, openTestDb, resetDb, withDb } from "./harness";

const describeDb = withDb ? describe : describe.skip;

const ROOT = "zfactory/plant-1/edge-1";

/** A telemetry message as the agent publishes it. */
function telemetry(
  plcId: string,
  at: Date,
  values: Array<{ id: string; value: number | boolean | null; quality?: string }>,
  extra: Record<string, unknown> = {},
) {
  return Buffer.from(
    JSON.stringify({
      schema: "zfactory.telemetry",
      version: 1,
      siteId: "plant-1",
      agentId: "edge-1",
      plcId,
      configVersion: 1,
      at: at.toISOString(),
      values: values.map((value) => ({
        id: value.id,
        name: value.id,
        value: value.value,
        quality: value.quality ?? "GOOD",
        at,
      })),
      ...extra,
    }),
  );
}

describeDb("telemetry ingestion, storage and queries (TASK-903)", () => {
  let db: PrismaClient;
  let store: PostgresTelemetryStore;
  let admin: Actor;
  let outsider: Actor;
  let organizationId: string;
  let siteId: string;
  let agentId: string;
  let plcA: string;
  let plcB: string;
  let now: Date;

  const pipelineAndIngestor = (options: ConstructorParameters<typeof TelemetryPipeline>[2] = {}) => {
    const pipeline = new TelemetryPipeline(db, store, { now: () => now, plcCacheMs: 0, ...options });
    const ingestor = new Ingestor(db, { now: () => now, agentCacheMs: 0, telemetry: pipeline });
    const deliver = async (topic: string, payload: Buffer) => {
      ingestor.handle(topic, payload);
      await ingestor.idle();
      await pipeline.idle();
    };
    return { pipeline, ingestor, deliver };
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
    const signedIn = await authenticate(db, "admin@acme.example", "a long admin password");
    admin = (await actorForSession(db, signedIn?.userId, signedIn?.sessionVersion))!;
    // bootstrapAdmin runs once; another organization and its admin are made directly.
    const organization = await db.organization.create({ data: { name: "Other Co", slug: "other-co" } });
    const user = await db.user.create({ data: { email: "owner@other.example", name: "Olga", passwordHash: "x" } });
    await db.membership.create({ data: { organizationId: organization.id, userId: user.id, role: "ADMIN" } });
    outsider = { userId: user.id, email: user.email, name: user.name };
    siteId = (await createSite(db, admin, organizationId, { siteKey: "plant-1", name: "Plant 1" })).id;
    agentId = (await createAgent(db, admin, siteId, { agentKey: "edge-1", name: "Edge 1" })).id;
    await registerDeployment(db, admin, agentId, deploymentFile({ plcId: "plc-a", plcName: "PLC-A" }));
    await registerDeployment(db, admin, agentId, deploymentFile({ plcId: "plc-b", plcName: "PLC-B" }));
    plcA = (await db.plc.findFirstOrThrow({ where: { externalPlcId: "plc-a" } })).id;
    plcB = (await db.plc.findFirstOrThrow({ where: { externalPlcId: "plc-b" } })).id;
    store = new PostgresTelemetryStore(db);
  });

  beforeEach(async () => {
    now = new Date();
    await db.$executeRawUnsafe('TRUNCATE telemetry.batch, telemetry.sample, "PlcEvent", "TagLatest"');
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores telemetry of several PLCs, queryable per tag, from the MQTT handler on", async () => {
    const { deliver, pipeline } = pipelineAndIngestor();
    const at = (seconds: number) => new Date(now.getTime() - 60_000 + seconds * 1000);
    for (let second = 0; second < 5; second += 1) {
      await deliver(
        `${ROOT}/telemetry/plc-a`,
        telemetry("plc-a", at(second), [
          { id: "t-speed", value: 10 + second },
          { id: "t-running", value: second % 2 === 0 },
        ]),
      );
      await deliver(
        `${ROOT}/telemetry/plc-b`,
        telemetry("plc-b", at(second), [{ id: "t-speed", value: 100 + second }]),
      );
    }
    expect(pipeline.stats).toMatchObject({ stored: 10, duplicates: 0, samples: 15, errors: 0 });

    const history = await getHistory(db, store, admin, plcA, {
      tag: "t-speed",
      from: at(0).toISOString(),
      to: at(10).toISOString(),
    });
    expect("samples" in history && history.samples.map((sample) => sample.value)).toEqual([10, 11, 12, 13, 14]);
    const running = await getHistory(db, store, admin, plcA, {
      tag: "t-running",
      from: at(0).toISOString(),
      to: at(10).toISOString(),
    });
    expect("samples" in running && running.samples.map((sample) => sample.value)).toEqual([
      true,
      false,
      true,
      false,
      true,
    ]);
    const other = await getHistory(db, store, admin, plcB, {
      tag: "t-speed",
      from: at(0).toISOString(),
      to: at(10).toISOString(),
    });
    expect("samples" in other && other.samples.at(-1)?.value).toBe(104);

    // Buckets of 2 s: min, max, average and the last value.
    const buckets = await getHistory(db, store, admin, plcA, {
      tag: "t-speed",
      from: at(0).toISOString(),
      to: at(10).toISOString(),
      bucket: "2",
    });
    expect(
      "buckets" in buckets && buckets.buckets.map((bucket) => [bucket.count, bucket.min, bucket.max, bucket.last]),
    ).toEqual([
      [2, 10, 11, 11],
      [2, 12, 13, 13],
      [1, 14, 14, 14],
    ]);

    // Latest values by scope: the organization, the site, the agent.
    for (const scope of [{ organizationId }, { siteId }, { agentId }]) {
      const latest = await getLatestInScope(db, admin, scope);
      expect(latest.plcs.map((plc) => plc.name)).toEqual(["PLC-A", "PLC-B"]);
    }
    const latestA = await getLatest(db, admin, plcA);
    expect(latestA.tags.find((tag) => tag.tag === "t-speed")).toMatchObject({ value: 14, reportedQuality: "GOOD" });
  });

  it("stores a redelivered or replayed batch once", async () => {
    const { deliver, pipeline } = pipelineAndIngestor();
    const at = new Date(now.getTime() - 5_000);
    const batch = telemetry("plc-a", at, [{ id: "t-speed", value: 7 }]);
    await deliver(`${ROOT}/telemetry/plc-a`, batch);
    await deliver(`${ROOT}/telemetry/plc-a`, batch);
    await deliver(`${ROOT}/telemetry/plc-a`, telemetry("plc-a", at, [{ id: "t-speed", value: 7 }], { replayed: true }));
    expect(pipeline.stats).toMatchObject({ stored: 1, duplicates: 2, samples: 1 });
    const [row] = await db.$queryRawUnsafe<Array<{ count: bigint }>>("SELECT count(*) FROM telemetry.sample");
    expect(Number(row?.count)).toBe(1);
    expect(await db.plcEvent.count()).toBe(1);
  });

  it("keeps the latest value deterministic when an older batch is replayed after a newer one", async () => {
    const { deliver } = pipelineAndIngestor();
    const newer = new Date(now.getTime() - 1_000);
    const older = new Date(now.getTime() - 60_000);
    await deliver(`${ROOT}/telemetry/plc-a`, telemetry("plc-a", newer, [{ id: "t-speed", value: 50 }]));
    await deliver(
      `${ROOT}/telemetry/plc-a`,
      telemetry("plc-a", older, [{ id: "t-speed", value: 1, quality: "BAD" }], { replayed: true }),
    );
    const latest = await db.tagLatest.findUniqueOrThrow({ where: { plcId_tag: { plcId: plcA, tag: "t-speed" } } });
    expect(latest).toMatchObject({ valueNum: 50, quality: "GOOD" });
    expect(latest.at.getTime()).toBe(newer.getTime());
    // The replayed sample is in the history all the same.
    const history = await store.history({
      plcId: plcA,
      tag: "t-speed",
      from: new Date(now.getTime() - 120_000),
      to: now,
      limit: 10,
    });
    expect(history.map((sample) => sample.value)).toEqual([1, 50]);
  });

  it("records quality changes and PLC state changes once, and projects stale and disconnected", async () => {
    const { deliver } = pipelineAndIngestor();
    const at = (seconds: number) => new Date(now.getTime() - 30_000 + seconds * 1000);
    await deliver(`${ROOT}/telemetry/plc-a`, telemetry("plc-a", at(0), [{ id: "t-speed", value: 1 }]));
    await deliver(`${ROOT}/telemetry/plc-a`, telemetry("plc-a", at(1), [{ id: "t-speed", value: 1, quality: "BAD" }]));
    await deliver(`${ROOT}/telemetry/plc-a`, telemetry("plc-a", at(2), [{ id: "t-speed", value: 2 }]));
    const state = (value: string, seconds: number) =>
      Buffer.from(
        JSON.stringify({
          schema: "zfactory.plc-state",
          version: 1,
          siteId: "plant-1",
          agentId: "edge-1",
          plcId: "plc-a",
          state: value,
          configVersion: 1,
          reconnects: 0,
          at: at(seconds).toISOString(),
        }),
      );
    await deliver(`${ROOT}/state/plc-a`, state("ONLINE", 0));
    await deliver(`${ROOT}/state/plc-a`, state("ONLINE", 0));
    await deliver(`${ROOT}/state/plc-a`, state("RECONNECTING", 3));
    const events = await getPlcEvents(db, admin, plcA, { from: at(-10).toISOString(), to: now.toISOString() });
    expect(events.events.map((event) => `${event.kind}:${event.subject}:${event.from}->${event.to}`)).toEqual([
      "PLC_STATE::ONLINE->RECONNECTING",
      "TAG_QUALITY:t-speed:BAD->GOOD",
      "TAG_QUALITY:t-speed:GOOD->BAD",
      "PLC_STATE::null->ONLINE",
      "TAG_QUALITY:t-speed:null->GOOD",
    ]);
    const onlyState = await getPlcEvents(db, admin, plcA, { kind: "PLC_STATE", from: at(-10).toISOString() });
    expect(onlyState.events).toHaveLength(2);

    // The agent is online (heartbeat) but the PLC is reconnecting: its values are disconnected.
    await deliver(
      `${ROOT}/agent/heartbeat`,
      Buffer.from(
        JSON.stringify({
          schema: "zfactory.agent-heartbeat",
          version: 1,
          siteId: "plant-1",
          agentId: "edge-1",
          uptimeS: 1,
          workers: 2,
          at: now.toISOString(),
        }),
      ),
    );
    let latest = await getLatest(db, admin, plcA, undefined, now);
    expect(latest.connection).toBe("RECONNECTING");
    expect(latest.tags.find((tag) => tag.tag === "t-speed")?.quality).toBe("DISCONNECTED");
    // Back online: the value is 28 s old at a 1 s poll interval, so stale.
    await deliver(`${ROOT}/state/plc-a`, state("ONLINE", 4));
    latest = await getLatest(db, admin, plcA, undefined, now);
    expect(latest.tags.find((tag) => tag.tag === "t-speed")).toMatchObject({
      quality: "STALE",
      reportedQuality: "GOOD",
    });
    latest = await getLatest(db, admin, plcA, undefined, new Date(at(2).getTime() + 1500));
    expect(latest.tags.find((tag) => tag.tag === "t-speed")?.quality).toBe("GOOD");
  });

  it("skips what is not registered and counts it", async () => {
    const { deliver, pipeline } = pipelineAndIngestor();
    await deliver(`${ROOT}/telemetry/plc-x`, telemetry("plc-x", now, [{ id: "t-speed", value: 1 }]));
    await deliver(
      `${ROOT}/telemetry/plc-a`,
      telemetry(
        "plc-a",
        now,
        [
          { id: "t-speed", value: 1 },
          { id: "t-ghost", value: 2 },
        ],
        { configVersion: 9 },
      ),
    );
    await deliver(
      `${ROOT}/telemetry/plc-a`,
      telemetry("plc-a", new Date(now.getTime() - 40 * 86_400_000), [{ id: "t-speed", value: 1 }]),
    );
    await deliver(
      `${ROOT}/telemetry/plc-a`,
      telemetry("plc-a", new Date(now.getTime() + 3_600_000), [{ id: "t-speed", value: 1 }]),
    );
    // The body names another PLC than the topic.
    await deliver(`${ROOT}/telemetry/plc-b`, telemetry("plc-a", now, [{ id: "t-speed", value: 1 }]));
    expect(pipeline.stats.dropped).toEqual({ overload: 0, "unknown-plc": 1, expired: 1, future: 1 });
    expect(pipeline.stats).toMatchObject({ stored: 1, samples: 1, unknownTags: 1, versionMismatches: 1 });
  });

  it("bounds its queue: overload drops the oldest batches and is counted", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = resolve));
    const written: ResolvedBatch[] = [];
    const slow: TelemetryStore = {
      write: async (batches) => {
        await gate;
        written.push(...batches);
        return { batches: batches.length, duplicates: 0, samples: 0, events: 0 };
      },
      history: async () => [],
      aggregate: async () => [],
      maintain: async () => ({ created: [], dropped: [] }),
    };
    const pipeline = new TelemetryPipeline(db, slow, { capacity: 10, writers: 1, groupSize: 1, now: () => now });
    const at = (index: number) => new Date(now.getTime() - 1000 + index);
    for (let index = 0; index < 50; index += 1) {
      pipeline.offer({
        agentId,
        receivedAt: now,
        message: {
          schema: "zfactory.telemetry",
          version: 1,
          siteId: "plant-1",
          agentId: "edge-1",
          plcId: "plc-a",
          configVersion: 1,
          at: at(index),
          values: [{ id: "t-speed", value: index, quality: "GOOD" }],
        },
      });
    }
    // One batch is being written; ten wait; the rest were dropped, oldest first.
    expect(pipeline.stats.queued).toBeLessThanOrEqual(10);
    expect(pipeline.stats.dropped.overload).toBe(39);
    release();
    await pipeline.idle();
    expect(written.map((batch) => batch.at.getTime() - at(0).getTime())).toEqual([
      0, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49,
    ]);
    expect(pipeline.stats.queued).toBe(0);
  });

  it("creates day partitions as needed and drops those past the retention", async () => {
    const day = 86_400_000;
    const today = new Date();
    await store.ensureDays([new Date(today.getTime() - 40 * day), new Date(today.getTime() - 29 * day)]);
    const { dropped } = await store.maintain(today, 30);
    const old = new Date(today.getTime() - 40 * day).toISOString().slice(0, 10).replaceAll("-", "");
    expect(dropped).toEqual([`batch_d${old}`, `sample_d${old}`]);
    const names = await db.$queryRawUnsafe<Array<{ relname: string }>>(
      "SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'telemetry' AND c.relname LIKE 'sample_d%'",
    );
    const kept = new Date(today.getTime() - 29 * day).toISOString().slice(0, 10).replaceAll("-", "");
    expect(names.map((row) => row.relname)).toContain(`sample_d${kept}`);
    expect(names.map((row) => row.relname)).not.toContain(`sample_d${old}`);
  });

  it("answers only what the actor may see, and refuses bad queries", async () => {
    await expect(getLatest(db, outsider, plcA)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getHistory(db, store, outsider, plcA, { tag: "t-speed" })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(getPlcEvents(db, outsider, plcA, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getConnectionHistory(db, outsider, agentId, {})).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getLatestInScope(db, outsider, { organizationId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getLatestInScope(db, outsider, { siteId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getLatest(db, admin, "not-a-uuid")).rejects.toMatchObject({ code: "NOT_FOUND" });

    await expect(getHistory(db, store, admin, plcA, { tag: "t-ghost" })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(getHistory(db, store, admin, plcA, {})).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      getHistory(db, store, admin, plcA, { tag: "t-speed", from: "2026-01-01T00:00:00Z", to: "2026-03-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(
      getHistory(db, store, admin, plcA, { tag: "t-speed", from: "2026-03-01T00:00:00Z", to: "2026-01-01T00:00:00Z" }),
    ).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(getHistory(db, store, admin, plcA, { tag: "t-speed", limit: "100000" })).rejects.toMatchObject({
      code: "VALIDATION",
    });
    await expect(getLatestInScope(db, admin, { siteId, agentId })).rejects.toMatchObject({ code: "VALIDATION" });
    const connections = await getConnectionHistory(db, admin, agentId, {});
    expect(connections.agentId).toBe(agentId);
  });
});
