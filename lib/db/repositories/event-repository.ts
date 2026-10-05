import "server-only";
import type { Db } from "@/lib/db/client";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { Prisma, Severity } from "@/lib/generated/prisma/client";

export type EventFilter = {
  severities?: readonly Severity[];
  types?: readonly string[];
  deviceId?: string;
};

export type AlarmKey = { factoryId: string; deviceId: string | null; code: string; sourceTagId?: string | null };

const eventWhere = (factoryId: string, filter: EventFilter): Prisma.RuntimeEventWhereInput => ({
  factoryId,
  ...(filter.severities?.length ? { severity: { in: [...filter.severities] } } : {}),
  ...(filter.types?.length ? { type: { in: [...filter.types] } } : {}),
  ...(filter.deviceId ? { deviceId: filter.deviceId } : {}),
});

/** Events, alarms and telemetry history. Live values are never read from here. */
export const eventRepository = {
  insertEvents(db: Db, events: readonly RuntimeEventEnvelope[]) {
    return db.runtimeEvent.createMany({
      data: events.map((event) => ({
        id: event.id,
        factoryId: event.factoryId,
        deviceId: event.deviceId,
        type: event.type,
        severity: event.severity,
        version: event.version,
        payloadJson: event.payload as Prisma.InputJsonObject,
        occurredAt: new Date(event.occurredAt),
      })),
    });
  },

  /** Newest first. */
  listEvents(db: Db, factoryId: string, filter: EventFilter, take: number) {
    return db.runtimeEvent.findMany({
      where: eventWhere(factoryId, filter),
      orderBy: [{ occurredAt: "desc" }, { id: "desc" }],
      take,
      include: { device: { select: { name: true } } },
    });
  },

  findEvent(db: Db, factoryId: string, id: string) {
    return db.runtimeEvent.findFirst({ where: { id, factoryId }, select: { id: true, occurredAt: true } });
  },

  /** Events recorded after the given one, oldest first: what a reconnecting client missed. */
  listEventsAfter(db: Db, factoryId: string, after: { id: string; occurredAt: Date }, take: number) {
    return db.runtimeEvent.findMany({
      where: {
        factoryId,
        OR: [{ occurredAt: { gt: after.occurredAt } }, { occurredAt: after.occurredAt, id: { gt: after.id } }],
      },
      orderBy: [{ occurredAt: "asc" }, { id: "asc" }],
      take,
    });
  },

  async countBySeverity(db: Db, factoryId: string, since: Date): Promise<Record<Severity, number>> {
    const groups = await db.runtimeEvent.groupBy({
      by: ["severity"],
      where: { factoryId, occurredAt: { gte: since } },
      _count: { _all: true },
    });
    const counts: Record<Severity, number> = { INFO: 0, WARNING: 0, CRITICAL: 0 };
    for (const group of groups) counts[group.severity] = group._count._all;
    return counts;
  },

  findActiveAlarm(db: Db, key: AlarmKey) {
    return db.alarmEvent.findFirst({
      where: {
        factoryId: key.factoryId,
        deviceId: key.deviceId,
        code: key.code,
        sourceTagId: key.sourceTagId ?? null,
        clearedAt: null,
      },
    });
  },

  createAlarm(db: Db, alarm: AlarmKey & { severity: Severity; message: string; startedAt: Date }) {
    return db.alarmEvent.create({
      data: {
        factoryId: alarm.factoryId,
        deviceId: alarm.deviceId,
        code: alarm.code,
        severity: alarm.severity,
        message: alarm.message,
        sourceTagId: alarm.sourceTagId ?? null,
        startedAt: alarm.startedAt,
      },
    });
  },

  listActiveAlarms(db: Db, where: Prisma.AlarmEventWhereInput) {
    return db.alarmEvent.findMany({ where: { ...where, clearedAt: null } });
  },

  clearAlarms(db: Db, ids: readonly string[], clearedAt: Date) {
    return db.alarmEvent.updateMany({ where: { id: { in: [...ids] }, clearedAt: null }, data: { clearedAt } });
  },

  /** Active alarms first, then the most recently cleared ones. */
  async listAlarms(db: Db, factoryId: string, recentCleared: number) {
    const include = { device: { select: { name: true } }, sourceTag: { select: { name: true } } } as const;
    const [active, cleared] = await Promise.all([
      db.alarmEvent.findMany({ where: { factoryId, clearedAt: null }, orderBy: { startedAt: "desc" }, include }),
      db.alarmEvent.findMany({
        where: { factoryId, clearedAt: { not: null } },
        orderBy: { clearedAt: "desc" },
        take: recentCleared,
        include,
      }),
    ]);
    return [...active, ...cleared];
  },

  countActiveAlarms(db: Db, factoryId: string) {
    return db.alarmEvent.count({ where: { factoryId, clearedAt: null } });
  },

  findAlarmForOwner(db: Db, ownerId: string, alarmId: string) {
    return db.alarmEvent.findFirst({ where: { id: alarmId, factory: { ownerId } } });
  },

  acknowledgeAlarm(db: Db, alarmId: string, acknowledgedAt: Date) {
    return db.alarmEvent.updateMany({ where: { id: alarmId, acknowledgedAt: null }, data: { acknowledgedAt } });
  },

  insertSamples(
    db: Db,
    samples: ReadonlyArray<{
      factoryId: string;
      deviceId: string | null;
      tagId: string;
      valueNumber: number;
      quality: "GOOD" | "STALE" | "BAD" | "DISCONNECTED";
      sampledAt: Date;
    }>,
  ) {
    return db.telemetrySample.createMany({ data: [...samples] });
  },

  /** Removes history beyond its retention. Active alarms are never removed. */
  async prune(db: Db, cutoff: { telemetryBefore: Date; eventsBefore: Date }) {
    const [samples, events, alarms] = await Promise.all([
      db.telemetrySample.deleteMany({ where: { sampledAt: { lt: cutoff.telemetryBefore } } }),
      db.runtimeEvent.deleteMany({ where: { occurredAt: { lt: cutoff.eventsBefore } } }),
      db.alarmEvent.deleteMany({ where: { clearedAt: { lt: cutoff.eventsBefore } } }),
    ]);
    return { samples: samples.count, events: events.count, alarms: alarms.count };
  },
};
