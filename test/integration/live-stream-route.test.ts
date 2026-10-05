// @vitest-environment node
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { EventBus } from "@/lib/events/bus";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_OPERATION_STATE } from "@/lib/plc/operation-state";
import { DeviceSimulatorRuntime } from "@/lib/runtimes/device-sim/runtime";
import { TagMonitorRuntime } from "@/lib/runtimes/tag-monitor/monitor";
import { listAlarms, recordEvent } from "@/lib/services/event-service";
import { createFactory } from "@/lib/services/factory-service";
import type { LiveDeps } from "@/lib/services/live-service";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * The live stream route and the live server actions with their real services and
 * database; only the request plumbing is replaced.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { ownerId: "alice" },
  liveDeps: undefined as unknown,
  runtimeDeps: (() => {
    throw new Error("not set");
  }) as () => unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => state.actor }));
vi.mock("@/lib/services/runtime-deps", () => ({
  getLiveDeps: () => state.liveDeps,
  getRuntimeDeps: () => state.runtimeDeps(),
}));

const { GET } = await import("@/app/factories/[factoryId]/stream/route");
const actions = await import("@/app/factories/[factoryId]/live-actions");

type Frame = { event: string; id: string | null; data: Record<string, unknown> };

/** Reads server-sent event frames from a response until `count` have arrived. */
function frames(response: Response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("no body");
  const decoder = new TextDecoder();
  let buffer = "";
  let retry: string | undefined;
  const parsed: Frame[] = [];

  const read = async (count: number): Promise<Frame[]> => {
    while (parsed.length < count) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let end = buffer.indexOf("\n\n");
      while (end >= 0) {
        const block = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const field = (name: string) =>
          block
            .split("\n")
            .find((line) => line.startsWith(`${name}: `))
            ?.slice(name.length + 2);
        if (field("retry")) retry = field("retry");
        const event = field("event");
        if (event)
          parsed.push({ event, id: field("id") ?? null, data: JSON.parse(field("data") ?? "{}") as Frame["data"] });
        end = buffer.indexOf("\n\n");
      }
    }
    return parsed.splice(0, count);
  };
  return { read, retry: () => retry, cancel: () => reader.cancel() };
}

describeDb("live stream route and live actions", () => {
  let db: PrismaClient;
  let deps: LiveDeps;
  let factoryId: string;
  const alice = { ownerId: "alice" };

  const open = (id: string, init: { lastEventId?: string; query?: string; signal?: AbortSignal } = {}) =>
    GET(
      new Request(`http://localhost/factories/${id}/stream${init.query ?? ""}`, {
        headers: init.lastEventId ? { "Last-Event-ID": init.lastEventId } : {},
        signal: init.signal,
      }),
      { params: Promise.resolve({ factoryId: id }) },
    );
  const record = (type: string) => recordEvent(deps, { type, factoryId, deviceId: null });

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
  });
  beforeEach(async () => {
    await resetDb(db);
    state.actor = alice;
    deps = {
      db,
      bus: new EventBus(),
      monitor: new TagMonitorRuntime(),
      simulator: new DeviceSimulatorRuntime(),
      autoTick: false,
    };
    state.liveDeps = deps;
    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
  });
  afterAll(async () => {
    await db.$disconnect();
  });

  it("streams server-sent events that are not cached or transformed, starting with the current state", async () => {
    const response = await open(factoryId);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-cache, no-transform");

    const stream = frames(response);
    const [snapshot] = await stream.read(1);
    expect(stream.retry()).toBe("3000");
    expect(snapshot).toMatchObject({ event: "snapshot", id: null });
    expect(snapshot?.data).toMatchObject({
      kind: "snapshot",
      snapshot: { factoryId, tags: [], devices: [], activeAlarms: 0 },
    });

    // A recorded event arrives as the bare envelope, with its id as the stream's event id.
    const recorded = await record("SIMULATION_STARTED");
    const [event] = await stream.read(1);
    expect(event).toEqual({ event: "event", id: recorded.id, data: recorded });
    await stream.cancel();
  });

  it("resumes after the last event a client saw, from the header or the query", async () => {
    const seen = await record("DEVICE_STARTING");
    const missed = [await record("DEVICE_RUNNING"), await record("SIMULATION_STARTED")];

    for (const init of [{ lastEventId: seen.id }, { query: `?lastEventId=${seen.id}` }]) {
      const stream = frames(await open(factoryId, init));
      const received = await stream.read(3);
      expect(received.map((frame) => [frame.event, frame.id])).toEqual([
        ["event", missed[0]?.id],
        ["event", missed[1]?.id],
        ["snapshot", null],
      ]);
      await stream.cancel();
    }

    const unknown = frames(await open(factoryId, { lastEventId: "018f6f2e-0000-7000-8000-000000000000" }));
    expect((await unknown.read(2)).map((frame) => [frame.event, frame.data.reason ?? null])).toEqual([
      ["reset", "UNKNOWN_EVENT"],
      ["snapshot", null],
    ]);
    await unknown.cancel();
  });

  it("lets go of its listener when the client goes away", async () => {
    const abort = new AbortController();
    const stream = frames(await open(factoryId, { signal: abort.signal }));
    await stream.read(1);
    expect(deps.bus.liveListenerCount(factoryId)).toBe(1);
    abort.abort();
    expect(deps.bus.liveListenerCount(factoryId)).toBe(0);

    const cancelled = frames(await open(factoryId));
    await cancelled.read(1);
    expect(deps.bus.liveListenerCount(factoryId)).toBe(1);
    await cancelled.cancel();
    expect(deps.bus.liveListenerCount(factoryId)).toBe(0);
  });

  it("answers 404 for a factory that is unknown, malformed or someone else's, without opening a stream", async () => {
    expect((await open("not-a-uuid")).status).toBe(404);
    expect((await open("018f6f2e-0000-7000-8000-000000000000")).status).toBe(404);
    state.actor = { ownerId: "bob" };
    const foreign = await open(factoryId);
    expect(foreign.status).toBe(404);
    expect(foreign.headers.get("content-type")).toContain("application/json");
    expect(deps.bus.liveListenerCount(factoryId)).toBe(0);
  });

  it("acknowledges an alarm through its action, once", async () => {
    await recordEvent(deps, {
      type: "DEVICE_FAULTED",
      factoryId,
      deviceId: null,
      severity: "CRITICAL",
      payload: { action: "start" },
    });
    const [alarm] = await listAlarms(db, alice, factoryId);
    const act = (alarmId: string) => actions.acknowledgeAlarmAction(factoryId, alarmId, EMPTY_OPERATION_STATE);

    expect(await act("not-a-uuid")).toEqual({ message: "The alarm does not exist." });
    state.actor = { ownerId: "bob" };
    expect(await act(alarm?.id ?? "")).toEqual({ message: "The alarm does not exist." });
    state.actor = alice;
    expect(await act(alarm?.id ?? "")).toEqual({ notice: "Acknowledged." });
    expect(await act(alarm?.id ?? "")).toEqual({ message: "The alarm is already acknowledged." });
    expect((await listAlarms(db, alice, factoryId))[0]).toMatchObject({ state: "ACTIVE_ACKNOWLEDGED" });
  });

  it("refuses a tag write that is not a value before anything reaches a PLC", async () => {
    const write = (value: string, plcId = "018f6f2e-0000-7000-8000-000000000000") => {
      const data = new FormData();
      data.set("value", value);
      return actions.writeTagAction(factoryId, plcId, "Start_Cmd", EMPTY_OPERATION_STATE, data);
    };
    expect(await write("")).toEqual({ message: "Enter a number." });
    expect(await write("fast")).toEqual({ message: "Enter a number." });
    expect(await write("true", "not-a-uuid")).toEqual({ message: "The PLC does not exist." });
    // A well-formed value for a PLC that does not exist: the runtime is asked, and says so.
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    expect(await write("12,5")).toEqual({ message: "Something went wrong. Try again." });
    log.mockRestore();
  });
});
