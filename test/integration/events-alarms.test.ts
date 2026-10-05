// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { NewRuntimeEvent, RuntimeEventEnvelope } from "@/lib/domain/events";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { createDeviceInstance } from "@/lib/services/device-service";
import {
  acknowledgeAlarm,
  countEventsBySeverity,
  type EventDeps,
  listAlarms,
  listEvents,
  MAX_REPLAY_EVENTS,
  pruneHistory,
  recordEvent,
  recordEvents,
  replayEvents,
} from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import { createGenericModel, describeDb, openTestDb, resetDb } from "./harness";

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

/** Recording, ordering, alarms, history and replay of runtime events, against PostgreSQL. */
describeDb("runtime events and alarms against PostgreSQL", () => {
  let db: PrismaClient;
  let deps: EventDeps;
  let published: RuntimeEventEnvelope[];
  let factoryId: string;
  let vfdId: string;
  let plcId: string;

  const on = (type: string, payload: Record<string, unknown> = {}, extra: Partial<NewRuntimeEvent> = {}) =>
    ({ type, factoryId, deviceId: vfdId, payload, ...extra }) satisfies NewRuntimeEvent;
  const stored = async () =>
    (await db.runtimeEvent.findMany({ where: { factoryId }, orderBy: [{ occurredAt: "asc" }, { id: "asc" }] })).filter(
      (event) => !["FACTORY_CREATED", "DEVICE_CREATED"].includes(event.type),
    );
  const alarms = () => listAlarms(db, alice, factoryId);

  beforeAll(async () => {
    db = openTestDb();
  });
  beforeEach(async () => {
    await resetDb(db);
    published = [];
    const bus = new EventBus();
    bus.subscribe((event) => published.push(event));
    deps = { db, bus };
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    const create = async (category: string, name: string) =>
      (
        await createDeviceInstance(db, {
          factoryId,
          deviceModelId: (
            await createGenericModel(
              db,
              category,
              `Generic ${category}`,
              category === "PLC" ? { architectureType: "COMPACT" } : {},
            )
          ).id,
          name,
        })
      ).id;
    vfdId = await create("VFD", "VFD-01");
    plcId = await create("PLC", "PLC-01");
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("stores and publishes events in one order, also when they are recorded at the same time", async () => {
    // Twenty callers at once, three events each.
    const batches = await Promise.all(
      Array.from({ length: 20 }, (_, batch) =>
        recordEvents(
          deps,
          [0, 1, 2].map((step) => on("VFD_STATE_CHANGED", { batch, step })),
        ),
      ),
    );
    const rows = await stored();
    expect(rows).toHaveLength(60);
    // The order in the database, the order of the ids and the order on the bus are the same.
    expect(rows.map((row) => row.id)).toEqual(published.map((event) => event.id));
    expect([...rows.map((row) => row.id)].sort()).toEqual(rows.map((row) => row.id));
    // What one caller recorded stays together and in its order.
    for (const batch of batches) {
      const positions = batch.map((event) => published.findIndex((candidate) => candidate.id === event.id));
      expect(positions).toEqual([positions[0], (positions[0] ?? 0) + 1, (positions[0] ?? 0) + 2]);
      expect(batch.map((event) => event.payload.step)).toEqual([0, 1, 2]);
    }
    expect(published[0]).toMatchObject({ version: 1, severity: "INFO", factoryId, deviceId: vfdId });
    expect(rows[0]?.occurredAt.toISOString()).toBe(published[0]?.occurredAt);
  });

  it("keeps recording after a batch that could not be stored", async () => {
    await expect(
      recordEvent(deps, { type: "X", factoryId: "018f6f2e-0000-7000-8000-000000000000", deviceId: null }),
    ).rejects.toThrow();
    expect((await recordEvent(deps, on("DEVICE_RESET"))).type).toBe("DEVICE_RESET");
    expect(published.map((event) => event.type)).toEqual(["DEVICE_RESET"]);
  });

  it("raises one alarm per fault, right behind the event that caused it, and ends it with the fault", async () => {
    await recordEvents(deps, [
      on("FAULT_INJECTED", { code: "DRY_RUN", name: "Dry running", latching: false }, { severity: "WARNING" }),
      // The same condition reported again is the same alarm.
      on("FAULT_INJECTED", { code: "DRY_RUN", name: "Dry running", latching: false }, { severity: "WARNING" }),
    ]);
    expect(published.map((event) => event.type)).toEqual(["FAULT_INJECTED", "ALARM_RAISED", "FAULT_INJECTED"]);
    expect(published[1]).toMatchObject({ severity: "WARNING", deviceId: vfdId, payload: { code: "FAULT:DRY_RUN" } });
    expect(await alarms()).toEqual([
      expect.objectContaining({
        code: "FAULT:DRY_RUN",
        message: "Dry running",
        severity: "WARNING",
        deviceName: "VFD-01",
        state: "ACTIVE_UNACKNOWLEDGED",
        clearedAt: null,
      }),
    ]);

    await recordEvent(deps, on("FAULT_CLEARED", { code: "DRY_RUN", stillTripped: false }));
    expect(published.slice(-2).map((event) => event.type)).toEqual(["FAULT_CLEARED", "ALARM_CLEARED"]);
    expect((await alarms())[0]).toMatchObject({ state: "CLEARED_UNACKNOWLEDGED" });
    // Clearing what is not active changes nothing.
    await recordEvent(deps, on("FAULT_CLEARED", { code: "DRY_RUN", stillTripped: false }));
    expect(published.at(-1)?.type).toBe("FAULT_CLEARED");
  });

  it("keeps a latching fault's alarm until the device leaves its faulted state, and a fault still present beyond that", async () => {
    await recordEvents(deps, [
      on("FAULT_INJECTED", { code: "OVERCURRENT", name: "Overcurrent trip", latching: true }, { severity: "CRITICAL" }),
      on(
        "FAULT_INJECTED",
        { code: "OVERTEMPERATURE", name: "Overtemperature trip", latching: true },
        { severity: "CRITICAL" },
      ),
      on("FAULT_CLEARED", { code: "OVERCURRENT", stillTripped: true }),
    ]);
    expect((await alarms()).filter((alarm) => alarm.clearedAt === null)).toHaveLength(2);

    await recordEvent(
      deps,
      on("VFD_STATE_CHANGED", { from: "FAULTED", to: "STOPPED", activeFaults: ["OVERTEMPERATURE"] }),
    );
    const after = await alarms();
    expect(after.find((alarm) => alarm.code === "FAULT:OVERCURRENT")?.clearedAt).not.toBeNull();
    expect(after.find((alarm) => alarm.code === "FAULT:OVERTEMPERATURE")?.clearedAt).toBeNull();

    await recordEvent(deps, on("DEVICE_RESET", { wasTripped: true, activeFaults: [] }));
    expect((await alarms()).every((alarm) => alarm.clearedAt !== null)).toBe(true);
  });

  it("ends simulated fault alarms when the simulation stops, and leaves the others", async () => {
    await recordEvents(deps, [
      on("FAULT_INJECTED", { code: "STUCK", name: "Stuck" }, { severity: "WARNING" }),
      on("DEVICE_FAULTED", { action: "start", code: "RUNTIME_FAILURE" }, { deviceId: plcId, severity: "CRITICAL" }),
      on("CONNECTION_DOWN", { link: "tag-monitor" }, { deviceId: plcId, severity: "WARNING" }),
      // The simulator's own link does not raise the PLC link alarm.
      on("CONNECTION_DOWN", { link: "device-simulator" }, { deviceId: plcId, severity: "WARNING" }),
    ]);
    expect((await alarms()).map((alarm) => alarm.code).sort()).toEqual([
      "FAULT:STUCK",
      "PLC_LINK_DOWN",
      "RUNTIME_FAULT",
    ]);

    await recordEvent(deps, { type: "SIMULATION_STOPPED", factoryId, deviceId: null, payload: { devices: 1 } });
    const active = (await alarms()).filter((alarm) => alarm.clearedAt === null).map((alarm) => alarm.code);
    expect(active.sort()).toEqual(["PLC_LINK_DOWN", "RUNTIME_FAULT"]);

    await recordEvents(deps, [
      on("DEVICE_RUNNING", { state: "RUNNING" }, { deviceId: plcId }),
      on("CONNECTION_UP", { link: "tag-monitor" }, { deviceId: plcId }),
    ]);
    expect((await alarms()).filter((alarm) => alarm.clearedAt === null)).toEqual([]);
  });

  it("acknowledges an alarm once, keeps who did it, and does not end the alarm by that", async () => {
    await recordEvent(deps, on("FAULT_INJECTED", { code: "STUCK", name: "Stuck" }, { severity: "WARNING" }));
    const [alarm] = await alarms();
    const alarmId = alarm?.id ?? "";

    await expectDomainError(acknowledgeAlarm(deps, bob, alarmId), "NOT_FOUND");
    await acknowledgeAlarm(deps, alice, alarmId);
    expect((await alarms())[0]).toMatchObject({ state: "ACTIVE_ACKNOWLEDGED", clearedAt: null });
    expect(published.at(-1)).toMatchObject({
      type: "ALARM_ACKNOWLEDGED",
      deviceId: vfdId,
      payload: { alarmId, code: "FAULT:STUCK", by: "alice" },
    });
    await expectDomainError(acknowledgeAlarm(deps, alice, alarmId), "CONFLICT", "alarm-acknowledged");

    await recordEvent(deps, on("FAULT_CLEARED", { code: "STUCK", stillTripped: false }));
    expect((await alarms())[0]).toMatchObject({ state: "CLEARED" });
  });

  it("lists recorded events newest first, by family, severity and device, for their owner only", async () => {
    await recordEvents(deps, [
      on("DEVICE_STARTING", {}, { deviceId: plcId }),
      on("PLC_PROGRAM_DEPLOYED", { version: 2 }, { deviceId: plcId }),
      on("VFD_STATE_CHANGED", { from: "STOPPED", to: "RUNNING" }),
      on("FAULT_INJECTED", { code: "OVERCURRENT", name: "Overcurrent trip" }, { severity: "CRITICAL" }),
      on("SOMETHING_NEW", { note: "not in the vocabulary" }),
    ]);
    const types = async (query: Parameters<typeof listEvents>[3]) =>
      (await listEvents(db, alice, factoryId, query)).map((event) => event.type);

    expect((await types({})).slice(0, 4)).toEqual([
      "SOMETHING_NEW",
      "ALARM_RAISED",
      "FAULT_INJECTED",
      "VFD_STATE_CHANGED",
    ]);
    expect(await types({ family: "FAULT" })).toEqual(["FAULT_INJECTED"]);
    expect(await types({ family: "ALARM" })).toEqual(["ALARM_RAISED"]);
    expect(await types({ family: "OTHER" })).toEqual(["SOMETHING_NEW"]);
    expect(await types({ severities: ["CRITICAL"] })).toEqual(["ALARM_RAISED", "FAULT_INJECTED"]);
    expect(await types({ deviceId: plcId, family: "PROGRAM" })).toEqual(["PLC_PROGRAM_DEPLOYED"]);
    expect(await types({ limit: 2 })).toHaveLength(2);

    const [newest] = await listEvents(db, alice, factoryId, { family: "FAULT" });
    expect(newest).toMatchObject({ deviceName: "VFD-01", family: "FAULT", payload: { code: "OVERCURRENT" } });
    expect(await countEventsBySeverity(db, alice, factoryId, 3_600_000)).toMatchObject({ CRITICAL: 2, WARNING: 0 });

    await expectDomainError(listEvents(db, bob, factoryId), "NOT_FOUND");
    await expectDomainError(listAlarms(db, bob, factoryId), "NOT_FOUND");
    await expectDomainError(countEventsBySeverity(db, bob, factoryId, 1000), "NOT_FOUND");
  });

  it("replays exactly what a client missed, in order, and says when it cannot", async () => {
    const first = await recordEvents(deps, [on("DEVICE_STARTING"), on("DEVICE_RUNNING")]);
    const missed = await recordEvents(deps, [
      on("FAULT_INJECTED", { code: "STUCK", name: "Stuck" }, { severity: "WARNING" }),
      on("FAULT_CLEARED", { code: "STUCK", stillTripped: false }),
    ]);

    const replay = await replayEvents(db, factoryId, first[1]?.id ?? "");
    expect(replay.kind).toBe("EVENTS");
    // The alarm events the faults caused are part of what was missed.
    expect(replay.kind === "EVENTS" && replay.events.map((event) => event.id)).toEqual(missed.map((event) => event.id));
    expect(missed.map((event) => event.type)).toEqual([
      "FAULT_INJECTED",
      "ALARM_RAISED",
      "FAULT_CLEARED",
      "ALARM_CLEARED",
    ]);
    // Nothing missed: an empty replay, not a reset.
    expect(await replayEvents(db, factoryId, missed.at(-1)?.id ?? "")).toEqual({ kind: "EVENTS", events: [] });

    expect(await replayEvents(db, factoryId, "018f6f2e-0000-7000-8000-000000000000")).toEqual({
      kind: "RESET",
      reason: "UNKNOWN_EVENT",
    });
    expect(await replayEvents(db, factoryId, "not-an-id")).toEqual({ kind: "RESET", reason: "UNKNOWN_EVENT" });
    // An event of another factory is not a place to resume from.
    const other = await createFactory(db, alice, { name: "Other", slug: "other", subnetCidr: "172.22.2.0/24" });
    expect(await replayEvents(db, other.id, first[0]?.id ?? "")).toEqual({ kind: "RESET", reason: "UNKNOWN_EVENT" });
  });

  it("asks a client that missed too much to load its lists again", async () => {
    const [anchor] = await recordEvents(deps, [on("DEVICE_STARTING")]);
    await recordEvents(
      deps,
      Array.from({ length: MAX_REPLAY_EVENTS }, (_, index) => on("SENSOR_VALUE_CHANGED", { index })),
    );
    const full = await replayEvents(db, factoryId, anchor?.id ?? "");
    expect(full.kind === "EVENTS" && full.events).toHaveLength(MAX_REPLAY_EVENTS);
    await recordEvent(deps, on("SENSOR_VALUE_CHANGED", { index: "one more" }));
    expect(await replayEvents(db, factoryId, anchor?.id ?? "")).toEqual({ kind: "RESET", reason: "TOO_MANY_EVENTS" });
  }, 30_000);

  it("removes history beyond its retention and never an active alarm", async () => {
    const now = Date.now();
    const daysAgo = (days: number) => new Date(now - days * 86_400_000);
    const tagless = { factoryId, deviceId: vfdId, valueNumber: 1, quality: "GOOD" as const };
    await db.telemetrySample.createMany({
      data: [
        { ...tagless, sampledAt: daysAgo(3) },
        { ...tagless, sampledAt: daysAgo(0.5) },
      ],
    });
    await db.runtimeEvent.createMany({
      data: [
        { factoryId, type: "OLD_EVENT", occurredAt: daysAgo(40) },
        { factoryId, type: "RECENT_EVENT", occurredAt: daysAgo(5) },
      ],
    });
    await db.alarmEvent.createMany({
      data: [
        { factoryId, code: "OLD_ACTIVE", severity: "WARNING", message: "still on", startedAt: daysAgo(90) },
        {
          factoryId,
          code: "OLD_CLEARED",
          severity: "WARNING",
          message: "gone",
          startedAt: daysAgo(90),
          clearedAt: daysAgo(60),
        },
        {
          factoryId,
          code: "RECENT_CLEARED",
          severity: "WARNING",
          message: "gone",
          startedAt: daysAgo(3),
          clearedAt: daysAgo(2),
        },
      ],
    });

    expect(await pruneHistory(db, { telemetryMs: 86_400_000, eventsMs: 30 * 86_400_000 }, now)).toEqual({
      samples: 1,
      events: 1,
      alarms: 1,
    });
    expect(await db.telemetrySample.count()).toBe(1);
    expect(
      (await db.runtimeEvent.findMany({ where: { type: { endsWith: "_EVENT" } } })).map((event) => event.type),
    ).toEqual(["RECENT_EVENT"]);
    expect((await db.alarmEvent.findMany({ orderBy: { code: "asc" } })).map((alarm) => alarm.code)).toEqual([
      "OLD_ACTIVE",
      "RECENT_CLEARED",
    ]);
  });
});
