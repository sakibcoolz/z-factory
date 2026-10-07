import "server-only";
import { z } from "zod";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { type ConnectivityLimits, DEFAULT_LIMITS, projectAgent, projectPlc } from "@/lib/domain/connectivity";
import type { EdgeDeploymentDocument } from "@/lib/domain/edge-deployment";
import { DomainError } from "@/lib/domain/errors";
import { projectQuality, type Quality, shownValue } from "@/lib/domain/telemetry";
import type { Prisma } from "@/lib/generated/prisma/client";
import type { TelemetryStore } from "@/lib/telemetry/store";

/**
 * Reading telemetry (TASK-903): latest values with their projected quality, a tag's
 * history (raw or in buckets), PLC events and agent connection history. Every query is
 * scoped to what the actor may see; anything else is NOT_FOUND.
 */

export const MAX_RANGE_MS = 31 * 86_400_000;
export const MAX_POINTS = 10_000;

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DomainError("VALIDATION", issue?.message ?? "Invalid query.", { field: issue?.path.join(".") });
  }
  return result.data;
}

/** A time range: `from` and `to` as ISO times, by default the last hour; at most 31 days. */
const rangeSchema = z
  .object({
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(MAX_POINTS).default(1000),
  })
  .transform((value, context) => {
    const to = value.to ?? new Date();
    const from = value.from ?? new Date(to.getTime() - 3_600_000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      context.addIssue({ code: "custom", message: "from and to are ISO times." });
      return z.NEVER;
    }
    if (from >= to) {
      context.addIssue({ code: "custom", message: "from must be before to.", path: ["from"] });
      return z.NEVER;
    }
    if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
      context.addIssue({ code: "custom", message: "The range is at most 31 days.", path: ["from"] });
      return z.NEVER;
    }
    return { from, to, limit: value.limit };
  });

const plcInclude = {
  agent: { include: { site: true } },
  mappings: { orderBy: { name: "asc" } },
  latest: true,
} satisfies Prisma.PlcInclude;

async function visiblePlc(db: Db, actor: Actor, plcId: string) {
  const plc = isUuid(plcId) ? await db.plc.findUnique({ where: { id: plcId }, include: plcInclude }) : null;
  if (!plc) throw notFound("PLC");
  await requireMembership(db, actor, plc.agent.site.organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("PLC");
    throw error;
  });
  return plc;
}

type PlcWithLatest = Prisma.PlcGetPayload<{ include: typeof plcInclude }>;

/** One PLC's tags with their latest values, quality projected now. */
function latestOf(plc: PlcWithLatest, now: Date, limits: ConnectivityLimits) {
  const agent = projectAgent(
    {
      status: plc.agent.status,
      lastSeenAt: plc.agent.lastSeenAt,
      heartbeat: plc.agent.heartbeatJson,
      credentialRevokedAt: plc.agent.credentialRevokedAt,
    },
    now,
    limits,
  );
  const connection = projectPlc({ edgeState: plc.edgeState, edgeLastError: plc.edgeLastError }, agent.state).state;
  const pollIntervalMs = (plc.deploymentJson as unknown as EdgeDeploymentDocument).deployment.connection.pollIntervalMs;
  const latest = new Map(plc.latest.map((row) => [row.tag, row]));
  return {
    plcId: plc.id,
    externalPlcId: plc.externalPlcId,
    name: plc.name,
    agentId: plc.edgeAgentId,
    siteId: plc.agent.siteId,
    connection,
    pollIntervalMs,
    tags: plc.mappings.map((mapping) => {
      const row = latest.get(mapping.externalId);
      return {
        tag: mapping.externalId,
        name: mapping.name,
        access: mapping.access,
        dataType: mapping.dataType,
        unit: mapping.unit,
        value: row ? shownValue({ num: row.valueNum, bool: row.valueBool }) : null,
        reportedQuality: (row?.quality ?? null) as Quality | null,
        quality: row
          ? projectQuality({ quality: row.quality as Quality, at: row.at }, connection, pollIntervalMs, now)
          : ("DISCONNECTED" as Quality),
        at: row?.at ?? null,
      };
    }),
  };
}

export async function getLatest(
  db: Db,
  actor: Actor,
  plcId: string,
  limits: ConnectivityLimits = DEFAULT_LIMITS,
  now = new Date(),
) {
  return latestOf(await visiblePlc(db, actor, plcId), now, limits);
}

const scopeSchema = z.union([
  z.strictObject({ organizationId: z.string() }),
  z.strictObject({ siteId: z.string() }),
  z.strictObject({ agentId: z.string() }),
]);

/** Latest values of every PLC in an organization, a site or an agent's care. */
export async function getLatestInScope(
  db: Db,
  actor: Actor,
  input: unknown,
  limits: ConnectivityLimits = DEFAULT_LIMITS,
  now = new Date(),
) {
  const scope = parse(scopeSchema, input);
  const id = "organizationId" in scope ? scope.organizationId : "siteId" in scope ? scope.siteId : scope.agentId;
  if (!isUuid(id)) throw notFound("scope");
  let organizationId: string;
  let where: Prisma.PlcWhereInput;
  if ("organizationId" in scope) {
    organizationId = id;
    where = { agent: { site: { organizationId: id } } };
  } else if ("siteId" in scope) {
    const site = await db.site.findUnique({ where: { id } });
    if (!site) throw notFound("site");
    organizationId = site.organizationId;
    where = { agent: { siteId: id } };
  } else {
    const agent = await db.edgeAgent.findUnique({ where: { id }, include: { site: true } });
    if (!agent) throw notFound("agent");
    organizationId = agent.site.organizationId;
    where = { edgeAgentId: id };
  }
  await requireMembership(db, actor, organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("scope");
    throw error;
  });
  const plcs = await db.plc.findMany({ where, include: plcInclude, orderBy: { name: "asc" } });
  return { plcs: plcs.map((plc) => latestOf(plc, now, limits)) };
}

const historySchema = z.object({
  tag: z.string().min(1).max(64),
  bucket: z.coerce.number().int().min(1).max(86_400).optional(),
});

/** A tag's history: raw samples, or buckets of `bucket` seconds with min, max, avg and last. */
export async function getHistory(
  db: Db,
  store: TelemetryStore,
  actor: Actor,
  plcId: string,
  input: Record<string, unknown>,
) {
  const plc = await visiblePlc(db, actor, plcId);
  const { tag, bucket } = parse(historySchema, input);
  const range = parse(rangeSchema, input);
  // Today's tags, or one that still has a latest value (a tag of an earlier version).
  if (!plc.mappings.some((mapping) => mapping.externalId === tag) && !plc.latest.some((row) => row.tag === tag)) {
    throw notFound("tag");
  }
  const query = { plcId: plc.id, tag, ...range };
  return bucket
    ? {
        plcId: plc.id,
        tag,
        ...range,
        bucketSeconds: bucket,
        buckets: await store.aggregate({ ...query, bucketMs: bucket * 1000 }),
      }
    : { plcId: plc.id, tag, ...range, samples: await store.history(query) };
}

const eventsSchema = z.object({ kind: z.enum(["PLC_STATE", "TAG_QUALITY"]).optional() });

/** What happened to a PLC and its tags in a range, newest first. */
export async function getPlcEvents(db: Db, actor: Actor, plcId: string, input: Record<string, unknown>) {
  const plc = await visiblePlc(db, actor, plcId);
  const { kind } = parse(eventsSchema, input);
  const range = parse(rangeSchema, input);
  const events = await db.plcEvent.findMany({
    where: { plcId: plc.id, at: { gte: range.from, lt: range.to }, ...(kind ? { kind } : {}) },
    // Events of the same time: the one recorded last first (ids are time-ordered).
    orderBy: [{ at: "desc" }, { id: "desc" }],
    take: range.limit,
  });
  return {
    plcId: plc.id,
    ...range,
    events: events.map((event) => ({
      kind: event.kind,
      subject: event.subject,
      from: event.fromValue,
      to: event.toValue,
      at: event.at,
    })),
  };
}

/** An agent's reported status changes in a range, newest first. */
export async function getConnectionHistory(db: Db, actor: Actor, agentId: string, input: Record<string, unknown>) {
  const agent = isUuid(agentId)
    ? await db.edgeAgent.findUnique({ where: { id: agentId }, include: { site: true } })
    : null;
  if (!agent) throw notFound("agent");
  await requireMembership(db, actor, agent.site.organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("agent");
    throw error;
  });
  const range = parse(rangeSchema, input);
  const events = await db.agentConnectionEvent.findMany({
    where: { edgeAgentId: agent.id, at: { gte: range.from, lt: range.to } },
    orderBy: { at: "desc" },
    take: range.limit,
  });
  return { agentId: agent.id, ...range, events: events.map((event) => ({ status: event.status, at: event.at })) };
}
