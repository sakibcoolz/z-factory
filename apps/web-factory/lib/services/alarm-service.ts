import "server-only";
import { z } from "zod";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { DomainError } from "@/lib/domain/errors";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { audit } from "./audit-service";

/**
 * Reading and acknowledging alarms (TASK-904). Everyone in the organization sees them;
 * operators and admins acknowledge (the `command` permission); each acknowledgement is
 * audited. Another organization's alarm does not exist for the actor.
 */

const notFound = () => new DomainError("NOT_FOUND", "The alarm does not exist.");

const SEVERITY_ORDER = { HIGH: 0, MEDIUM: 1, LOW: 2 } as const;

const querySchema = z.object({
  state: z.enum(["active", "history"]).default("active"),
  siteId: z.string().optional(),
  agentId: z.string().optional(),
  plcId: z.string().optional(),
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(200),
});

export type AlarmView = {
  id: string;
  source: string;
  severity: "HIGH" | "MEDIUM" | "LOW";
  message: string;
  siteId: string;
  siteName: string;
  agentId: string | null;
  plcId: string | null;
  subject: string;
  active: boolean;
  raisedAt: Date;
  clearedAt: Date | null;
  acknowledgedAt: Date | null;
  acknowledgedBy: string | null;
};

/**
 * Alarms of an organization. `active`: those active or cleared but not yet acknowledged,
 * most severe first. `history`: everything raised in a range (default the last 7 days),
 * newest first. Narrowed to a site, an agent or a PLC on request.
 */
export async function listAlarms(db: Db, actor: Actor, organizationId: string, input: Record<string, unknown> = {}) {
  const { role } = await requireMembership(db, actor, organizationId, "view");
  const parsed = querySchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid query.");
  }
  const query = parsed.data;
  const where: Prisma.AlarmWhereInput = { organizationId };
  for (const field of ["siteId", "agentId", "plcId"] as const) {
    const value = query[field];
    if (value !== undefined) {
      if (!isUuid(value)) throw new DomainError("VALIDATION", `${field} is not an id.`);
      where[field] = value;
    }
  }
  let rows;
  if (query.state === "active") {
    rows = await db.alarm.findMany({
      where: { ...where, OR: [{ activeKey: { not: null } }, { acknowledgedAt: null }] },
      orderBy: { raisedAt: "desc" },
      take: query.limit,
    });
    rows.sort(
      (a, b) =>
        Number(b.activeKey !== null) - Number(a.activeKey !== null) ||
        SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] ||
        b.raisedAt.getTime() - a.raisedAt.getTime(),
    );
  } else {
    const to = query.to ?? new Date();
    const from = query.from ?? new Date(to.getTime() - 7 * 86_400_000);
    rows = await db.alarm.findMany({
      where: { ...where, raisedAt: { gte: from, lt: to } },
      orderBy: { raisedAt: "desc" },
      take: query.limit,
    });
  }
  const sites = new Map(
    (await db.site.findMany({ where: { organizationId }, select: { id: true, name: true } })).map((site) => [
      site.id,
      site.name,
    ]),
  );
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: rows.flatMap((row) => (row.acknowledgedBy ? [row.acknowledgedBy] : [])) } },
        select: { id: true, name: true },
      })
    ).map((user) => [user.id, user.name]),
  );
  return {
    role,
    alarms: rows.map((row): AlarmView => ({
      id: row.id,
      source: row.source,
      severity: row.severity,
      message: row.message,
      siteId: row.siteId,
      siteName: sites.get(row.siteId) ?? "",
      agentId: row.agentId,
      plcId: row.plcId,
      subject: row.subject,
      active: row.activeKey !== null,
      raisedAt: row.raisedAt,
      clearedAt: row.clearedAt,
      acknowledgedAt: row.acknowledgedAt,
      acknowledgedBy: row.acknowledgedBy ? (users.get(row.acknowledgedBy) ?? "a former user") : null,
    })),
  };
}

/** Acknowledges an alarm; acknowledging it again changes nothing. */
export async function acknowledgeAlarm(db: PrismaClient, actor: Actor, alarmId: string) {
  const alarm = isUuid(alarmId) ? await db.alarm.findUnique({ where: { id: alarmId } }) : null;
  if (!alarm) throw notFound();
  await requireMembership(db, actor, alarm.organizationId, "command").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound();
    throw error;
  });
  if (alarm.acknowledgedAt) return { alarm, changed: false };
  const { count } = await db.alarm.updateMany({
    where: { id: alarm.id, acknowledgedAt: null },
    data: { acknowledgedAt: new Date(), acknowledgedBy: actor.userId },
  });
  if (count === 0) return { alarm, changed: false };
  await audit(db, {
    organizationId: alarm.organizationId,
    actorUserId: actor.userId,
    action: "ALARM_ACKNOWLEDGED",
    subjectType: "ALARM",
    subjectId: alarm.id,
    detail: { source: alarm.source, severity: alarm.severity, message: alarm.message },
  });
  return { alarm: await db.alarm.findUniqueOrThrow({ where: { id: alarm.id } }), changed: true };
}
