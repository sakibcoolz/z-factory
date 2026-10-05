import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { type EventFilter, eventRepository } from "@/lib/db/repositories/event-repository";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { type AlarmEffect, alarmEffects, alarmState, type AlarmState, FAULT_ALARM_PREFIX } from "@/lib/domain/alarms";
import { DomainError } from "@/lib/domain/errors";
import {
  EVENT_VERSION,
  type EventFamily,
  eventFamily,
  type EventSeverity,
  eventTypesOf,
  type NewRuntimeEvent,
  type RuntimeEventEnvelope,
} from "@/lib/domain/events";
import type { EventBus } from "@/lib/events/bus";
import { nextEventStamp } from "@/lib/events/event-id";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * The one place runtime events are recorded: every event gets its identity and time
 * here, is stored, raises or clears alarms, and is then published to live listeners.
 *
 * Recording is serialized per server process. Events are therefore stored and published
 * in the order of their ids, which is what lets a reconnecting client ask for "everything
 * after the last event I saw" and miss nothing.
 */

export type EventDeps = { db: PrismaClient; bus?: EventBus };

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

// One queue per server process, however many copies of this module the bundler makes.
const recording = globalThis as typeof globalThis & { zfactoryEventQueue?: Promise<unknown> };

/** Runs tasks one after the other; a failed task does not stop the ones behind it. */
function serialized<T>(task: () => Promise<T>): Promise<T> {
  const run = (recording.zfactoryEventQueue ?? Promise.resolve()).then(task, task);
  recording.zfactoryEventQueue = run.catch(() => undefined);
  return run;
}

function stamp(event: NewRuntimeEvent): RuntimeEventEnvelope {
  return {
    version: EVENT_VERSION,
    ...nextEventStamp(),
    type: event.type,
    factoryId: event.factoryId,
    deviceId: event.deviceId,
    severity: event.severity ?? "INFO",
    payload: event.payload ?? {},
  };
}

type AlarmChange = { type: "ALARM_RAISED" | "ALARM_CLEARED"; severity: EventSeverity; alarm: AlarmRow };
type AlarmRow = { id: string; factoryId: string; deviceId: string | null; code: string; message: string };

const alarmEvent = (change: AlarmChange): NewRuntimeEvent => ({
  type: change.type,
  factoryId: change.alarm.factoryId,
  deviceId: change.alarm.deviceId,
  severity: change.severity,
  payload: { alarmId: change.alarm.id, code: change.alarm.code, message: change.alarm.message },
});

/** Applies one alarm effect; returns the alarm events it caused. */
async function applyEffect(
  db: PrismaClient,
  factoryId: string,
  effect: AlarmEffect,
  at: Date,
  sourceTagId?: string,
): Promise<NewRuntimeEvent[]> {
  if (effect.kind === "RAISE") {
    const key = { factoryId, deviceId: effect.deviceId, code: effect.code, sourceTagId };
    // The condition is already known: one alarm per condition, however often it is reported.
    if (await eventRepository.findActiveAlarm(db, key)) return [];
    const alarm = await eventRepository.createAlarm(db, {
      ...key,
      severity: effect.severity,
      message: effect.message,
      startedAt: at,
    });
    return [alarmEvent({ type: "ALARM_RAISED", severity: effect.severity, alarm })];
  }

  const active = await eventRepository.listActiveAlarms(
    db,
    effect.kind === "CLEAR"
      ? { factoryId, deviceId: effect.deviceId, code: effect.code, sourceTagId: sourceTagId ?? null }
      : effect.kind === "CLEAR_DEVICE_FAULTS"
        ? {
            factoryId,
            deviceId: effect.deviceId,
            code: {
              startsWith: FAULT_ALARM_PREFIX,
              notIn: effect.stillActive.map((code) => `${FAULT_ALARM_PREFIX}${code}`),
            },
          }
        : { factoryId, code: { startsWith: FAULT_ALARM_PREFIX } },
  );
  if (active.length === 0) return [];
  await eventRepository.clearAlarms(
    db,
    active.map((alarm) => alarm.id),
    at,
  );
  return active.map((alarm) => alarmEvent({ type: "ALARM_CLEARED", severity: "INFO", alarm }));
}

async function store(deps: EventDeps, events: readonly NewRuntimeEvent[]): Promise<RuntimeEventEnvelope[]> {
  const recorded: RuntimeEventEnvelope[] = [];
  for (const event of events) {
    const envelope = stamp(event);
    await eventRepository.insertEvents(deps.db, [envelope]);
    recorded.push(envelope);
    const at = new Date(envelope.occurredAt);
    for (const effect of alarmEffects(envelope)) {
      for (const caused of await applyEffect(deps.db, envelope.factoryId, effect, at)) {
        const alarmEnvelope = stamp(caused);
        await eventRepository.insertEvents(deps.db, [alarmEnvelope]);
        recorded.push(alarmEnvelope);
      }
    }
  }
  return recorded;
}

/**
 * Records events in the given order, with the alarm events they cause right behind
 * them, and publishes all of them. Returns what was recorded.
 */
export function recordEvents(deps: EventDeps, events: readonly NewRuntimeEvent[]): Promise<RuntimeEventEnvelope[]> {
  if (events.length === 0) return Promise.resolve([]);
  return serialized(async () => {
    const recorded = await store(deps, events);
    recorded.forEach((envelope) => deps.bus?.publish(envelope));
    return recorded;
  });
}

export async function recordEvent(deps: EventDeps, event: NewRuntimeEvent): Promise<RuntimeEventEnvelope> {
  const [recorded] = await recordEvents(deps, [event]);
  if (!recorded) throw new DomainError("INVARIANT", "The event was not recorded.");
  return recorded;
}

/**
 * Raises or clears the alarm of an ALARM tag the PLC program drives. The PLC decides
 * that there is an alarm; this only keeps the record of when it began and ended.
 */
export function setTagAlarm(
  deps: EventDeps,
  alarm: { factoryId: string; deviceId: string | null; tagId: string; code: string; message: string },
  active: boolean,
): Promise<RuntimeEventEnvelope[]> {
  return serialized(async () => {
    const effect: AlarmEffect = active
      ? { kind: "RAISE", deviceId: alarm.deviceId, code: alarm.code, severity: "WARNING", message: alarm.message }
      : { kind: "CLEAR", deviceId: alarm.deviceId, code: alarm.code };
    const caused = await applyEffect(deps.db, alarm.factoryId, effect, new Date(), alarm.tagId);
    const recorded = caused.map(stamp);
    if (recorded.length > 0) await eventRepository.insertEvents(deps.db, recorded);
    recorded.forEach((envelope) => deps.bus?.publish(envelope));
    return recorded;
  });
}

/** Ends every alarm raised from the ALARM tags of one PLC: a PLC that is not running asserts nothing. */
export function clearTagAlarms(deps: EventDeps, factoryId: string, tagIds: readonly string[]) {
  if (tagIds.length === 0) return Promise.resolve([]);
  return serialized(async () => {
    const active = await eventRepository.listActiveAlarms(deps.db, { factoryId, sourceTagId: { in: [...tagIds] } });
    if (active.length === 0) return [];
    await eventRepository.clearAlarms(
      deps.db,
      active.map((alarm) => alarm.id),
      new Date(),
    );
    const recorded = active.map((alarm) => stamp(alarmEvent({ type: "ALARM_CLEARED", severity: "INFO", alarm })));
    await eventRepository.insertEvents(deps.db, recorded);
    recorded.forEach((envelope) => deps.bus?.publish(envelope));
    return recorded;
  });
}

export type EventView = RuntimeEventEnvelope & { deviceName: string | null; family: EventFamily };

export type EventQuery = {
  severities?: readonly EventSeverity[];
  family?: EventFamily;
  deviceId?: string;
  limit?: number;
};

const MAX_EVENTS = 500;

function toEnvelope(record: {
  id: string;
  type: string;
  factoryId: string;
  deviceId: string | null;
  severity: EventSeverity;
  occurredAt: Date;
  payloadJson: unknown;
}): RuntimeEventEnvelope {
  const payload = record.payloadJson;
  return {
    version: EVENT_VERSION,
    id: record.id,
    type: record.type,
    factoryId: record.factoryId,
    deviceId: record.deviceId,
    severity: record.severity,
    occurredAt: record.occurredAt.toISOString(),
    payload:
      typeof payload === "object" && payload !== null && !Array.isArray(payload)
        ? (payload as Record<string, unknown>)
        : {},
  };
}

async function requireFactory(db: PrismaClient, actor: Actor, factoryId: string) {
  if (!(await factoryRepository.findById(db, actor.ownerId, factoryId))) throw notFound("factory");
}

/** Recorded events of a factory, newest first. History, not live state. */
export async function listEvents(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
  query: EventQuery = {},
): Promise<EventView[]> {
  await requireFactory(db, actor, factoryId);
  const filter: EventFilter = {
    severities: query.severities,
    deviceId: query.deviceId,
    // OTHER is everything the vocabulary does not know; it cannot be listed by type.
    types: query.family && query.family !== "OTHER" ? eventTypesOf(query.family) : undefined,
  };
  const records = await eventRepository.listEvents(
    db,
    factoryId,
    filter,
    Math.min(Math.max(query.limit ?? 200, 1), MAX_EVENTS),
  );
  return records
    .map((record) => ({
      ...toEnvelope(record),
      deviceName: record.device?.name ?? null,
      family: eventFamily(record.type),
    }))
    .filter((event) => query.family !== "OTHER" || event.family === "OTHER");
}

export async function countEventsBySeverity(db: PrismaClient, actor: Actor, factoryId: string, sinceMs: number) {
  await requireFactory(db, actor, factoryId);
  return eventRepository.countBySeverity(db, factoryId, new Date(Date.now() - sinceMs));
}

/** Most events a reconnecting client is sent; beyond that it loads its lists again. */
export const MAX_REPLAY_EVENTS = 500;

export type Replay =
  { kind: "EVENTS"; events: RuntimeEventEnvelope[] } | { kind: "RESET"; reason: "UNKNOWN_EVENT" | "TOO_MANY_EVENTS" };

/**
 * What a client that last saw `lastEventId` missed, oldest first. An id the factory does
 * not have (never existed, or beyond retention) cannot be resumed from.
 */
export async function replayEvents(db: PrismaClient, factoryId: string, lastEventId: string): Promise<Replay> {
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const last = UUID.test(lastEventId) ? await eventRepository.findEvent(db, factoryId, lastEventId) : null;
  if (!last) return { kind: "RESET", reason: "UNKNOWN_EVENT" };
  const records = await eventRepository.listEventsAfter(db, factoryId, last, MAX_REPLAY_EVENTS + 1);
  if (records.length > MAX_REPLAY_EVENTS) return { kind: "RESET", reason: "TOO_MANY_EVENTS" };
  return { kind: "EVENTS", events: records.map(toEnvelope) };
}

export type AlarmView = {
  id: string;
  code: string;
  severity: EventSeverity;
  message: string;
  deviceId: string | null;
  deviceName: string | null;
  tagName: string | null;
  startedAt: string;
  clearedAt: string | null;
  acknowledgedAt: string | null;
  state: AlarmState;
};

/** Alarms of a factory: the active ones, then the most recently cleared. */
export async function listAlarms(db: PrismaClient, actor: Actor, factoryId: string): Promise<AlarmView[]> {
  await requireFactory(db, actor, factoryId);
  return (await eventRepository.listAlarms(db, factoryId, 25)).map((alarm) => ({
    id: alarm.id,
    code: alarm.code,
    severity: alarm.severity,
    message: alarm.message,
    deviceId: alarm.deviceId,
    deviceName: alarm.device?.name ?? null,
    tagName: alarm.sourceTag?.name ?? null,
    startedAt: alarm.startedAt.toISOString(),
    clearedAt: alarm.clearedAt?.toISOString() ?? null,
    acknowledgedAt: alarm.acknowledgedAt?.toISOString() ?? null,
    state: alarmState(alarm),
  }));
}

/**
 * An operator has seen the alarm. Acknowledging does not end it: the condition ends
 * when its cause does. Who acknowledged is kept in the recorded event.
 */
export async function acknowledgeAlarm(deps: EventDeps, actor: Actor, alarmId: string): Promise<void> {
  const alarm = await eventRepository.findAlarmForOwner(deps.db, actor.ownerId, alarmId);
  if (!alarm) throw notFound("alarm");
  if (alarm.acknowledgedAt) {
    throw new DomainError("CONFLICT", "The alarm is already acknowledged.", { rule: "alarm-acknowledged" });
  }
  const { count } = await eventRepository.acknowledgeAlarm(deps.db, alarm.id, new Date());
  if (count === 0) return;
  await recordEvent(deps, {
    type: "ALARM_ACKNOWLEDGED",
    factoryId: alarm.factoryId,
    deviceId: alarm.deviceId,
    payload: { alarmId: alarm.id, code: alarm.code, message: alarm.message, by: actor.ownerId },
  });
}

/** Removes telemetry and event history beyond its retention. */
export function pruneHistory(db: PrismaClient, retention: { telemetryMs: number; eventsMs: number }, now = Date.now()) {
  return eventRepository.prune(db, {
    telemetryBefore: new Date(now - retention.telemetryMs),
    eventsBefore: new Date(now - retention.eventsMs),
  });
}
