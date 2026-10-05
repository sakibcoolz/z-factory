// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import {
  alarmCodeLabel,
  type AlarmEffect,
  alarmEffects,
  alarmState,
  FAULT_ALARM_PREFIX,
  PLC_LINK_ALARM,
  RUNTIME_FAULT_ALARM,
} from "@/lib/domain/alarms";
import {
  eventDetail,
  eventFamily,
  eventTypesOf,
  KNOWN_EVENT_TYPES,
  type RuntimeEventEnvelope,
} from "@/lib/domain/events";
import {
  applyTagMessage,
  confirmReadings,
  type LiveTagReading,
  mergeReadings,
  qualityAt,
  tagKey,
} from "@/lib/domain/live";
import { SIMULATION_EVENT_TYPES } from "@/lib/domain/simulation";
import { EventBus } from "./bus";
import { nextEventStamp } from "./event-id";
import { encodeSse, sseRetry } from "./sse";

const event = (type: string, payload: Record<string, unknown> = {}, deviceId: string | null = "dev-1") =>
  ({
    version: 1,
    id: "0199b000-0000-7000-8000-000000000001",
    type,
    factoryId: "factory-1",
    deviceId,
    severity: "WARNING",
    occurredAt: "2026-10-05T05:00:00.000Z",
    payload,
  }) satisfies RuntimeEventEnvelope;

describe("event ids", () => {
  it("are UUID v7 and strictly increasing, also within one millisecond", () => {
    const stamps = Array.from({ length: 6000 }, () => nextEventStamp(1_800_000_000_000));
    const ids = stamps.map((stamp) => stamp.id);
    expect(ids[0]).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect([...ids].sort()).toEqual(ids);
    expect(new Set(ids).size).toBe(ids.length);
    // More events than one millisecond holds borrow the next one; time never goes back.
    const times = stamps.map((stamp) => Date.parse(stamp.occurredAt));
    expect(times[0]).toBe(1_800_000_000_000);
    expect(times.at(-1)).toBe(1_800_000_000_001);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("keep their order when the clock steps back", () => {
    const later = nextEventStamp(1_900_000_000_000);
    const earlierClock = nextEventStamp(1_899_999_999_000);
    expect(earlierClock.id > later.id).toBe(true);
    expect(Date.parse(earlierClock.occurredAt)).toBeGreaterThanOrEqual(Date.parse(later.occurredAt));
  });

  it("carry the time they are stamped with", () => {
    const stamp = nextEventStamp(2_000_000_000_000);
    expect(stamp.occurredAt).toBe(new Date(2_000_000_000_000).toISOString());
    expect(Number.parseInt(stamp.id.replace(/-/g, "").slice(0, 12), 16)).toBe(2_000_000_000_000);
  });
});

describe("event bus", () => {
  it("delivers a recorded event to event listeners and to the live listeners of its factory only", () => {
    const bus = new EventBus();
    const events: string[] = [];
    const mine: string[] = [];
    const other: string[] = [];
    bus.subscribe((received) => events.push(received.type));
    const stop = bus.subscribeLive("factory-1", (message) => mine.push(message.kind));
    bus.subscribeLive("factory-2", (message) => other.push(message.kind));

    bus.publish(event("VFD_STATE_CHANGED"));
    bus.publishLive("factory-1", { kind: "heartbeat", at: "2026-10-05T05:00:00.000Z" });
    expect(events).toEqual(["VFD_STATE_CHANGED"]);
    expect(mine).toEqual(["event", "heartbeat"]);
    expect(other).toEqual([]);
    expect(bus.liveListenerCount("factory-1")).toBe(1);

    stop();
    bus.publish(event("VFD_STATE_CHANGED"));
    expect(mine).toHaveLength(2);
    expect(bus.liveListenerCount("factory-1")).toBe(0);
  });

  it("keeps delivering when one listener fails", () => {
    const bus = new EventBus();
    const seen = vi.fn();
    bus.subscribeLive("factory-1", () => {
      throw new Error("broken listener");
    });
    bus.subscribeLive("factory-1", seen);
    bus.publish(event("FAULT_INJECTED"));
    expect(seen).toHaveBeenCalledOnce();
  });
});

describe("server-sent events encoding", () => {
  it("gives only recorded events an id a client can resume from", () => {
    const recorded = event("FAULT_INJECTED", { code: "STUCK" });
    expect(encodeSse({ kind: "event", event: recorded })).toBe(
      `event: event\nid: ${recorded.id}\ndata: ${JSON.stringify(recorded)}\n\n`,
    );
    const tags = encodeSse({
      kind: "tags",
      factoryId: "factory-1",
      plcId: "plc-1",
      at: "2026-10-05T05:00:00.000Z",
      confirmed: true,
      readings: [],
    });
    expect(tags.startsWith("event: tags\ndata: {")).toBe(true);
    expect(tags).not.toContain("\nid:");
    expect(encodeSse({ kind: "reset", reason: "UNKNOWN_EVENT" })).not.toContain("\nid:");
  });

  it("keeps a message on one data line whatever its text contains", () => {
    const encoded = encodeSse({ kind: "event", event: event("ALARM_RAISED", { message: "line one\nline two\r\n" }) });
    expect(encoded.split("\n").filter((line) => line.startsWith("data: "))).toHaveLength(1);
    expect(encoded.endsWith("\n\n")).toBe(true);
    expect(sseRetry()).toBe("retry: 3000\n\n");
  });
});

describe("event vocabulary", () => {
  it("puts every type the simulator emits into a family, and unknown types into OTHER", () => {
    for (const type of SIMULATION_EVENT_TYPES) expect(eventFamily(type), type).not.toBe("OTHER");
    expect(eventFamily("SOMETHING_NEW")).toBe("OTHER");
    expect(eventTypesOf("ALARM").sort()).toEqual(["ALARM_ACKNOWLEDGED", "ALARM_CLEARED", "ALARM_RAISED"]);
    expect(new Set(KNOWN_EVENT_TYPES).size).toBe(KNOWN_EVENT_TYPES.length);
  });

  it("describes a payload from known keys only", () => {
    expect(eventDetail({ tag: "Start_Cmd", value: true, source: "UI", commandId: "abc" })).toBe(
      "tag Start_Cmd · value true · source UI",
    );
    expect(eventDetail({ from: "RUNNING", to: "FAULTED", outputs: { current: 3 }, activeFaults: ["X"] })).toBe(
      "from RUNNING · to FAULTED",
    );
    expect(eventDetail({ log: ["/workdir/x"], containerId: "abc", path: "/var/run/docker.sock" })).toBe("");
  });
});

describe("alarm rules", () => {
  const effects = (type: string, payload: Record<string, unknown> = {}, deviceId: string | null = "dev-1") =>
    alarmEffects(event(type, payload, deviceId));

  it("raises an alarm for a device fault and ends it when the fault is gone", () => {
    expect(effects("FAULT_INJECTED", { code: "DRY_RUN", name: "Dry running", latching: false })).toEqual([
      {
        kind: "RAISE",
        deviceId: "dev-1",
        code: `${FAULT_ALARM_PREFIX}DRY_RUN`,
        severity: "WARNING",
        message: "Dry running",
      },
    ] satisfies AlarmEffect[]);
    expect(effects("FAULT_CLEARED", { code: "DRY_RUN", stillTripped: false })).toEqual([
      { kind: "CLEAR", deviceId: "dev-1", code: `${FAULT_ALARM_PREFIX}DRY_RUN` },
    ]);
  });

  it("keeps the alarm of a latching fault until the device leaves its faulted state", () => {
    expect(effects("FAULT_CLEARED", { code: "OVERCURRENT", stillTripped: true })).toEqual([]);
    expect(effects("DEVICE_RESET", { wasTripped: true, activeFaults: [] })).toEqual([
      { kind: "CLEAR_DEVICE_FAULTS", deviceId: "dev-1", stillActive: [] },
    ]);
    // The PLC's reset signal shows as the device leaving FAULTED; a fault still present keeps its alarm.
    expect(effects("VFD_STATE_CHANGED", { from: "FAULTED", to: "STOPPED", activeFaults: ["OVERTEMPERATURE"] })).toEqual(
      [{ kind: "CLEAR_DEVICE_FAULTS", deviceId: "dev-1", stillActive: ["OVERTEMPERATURE"] }],
    );
    expect(effects("VFD_STATE_CHANGED", { from: "RUNNING", to: "FAULTED" })).toEqual([]);
    expect(effects("VFD_STATE_CHANGED", { from: "STOPPED", to: "RUNNING" })).toEqual([]);
  });

  it("raises a runtime fault for a failed PLC runtime and ends it when the runtime is in another state", () => {
    expect(effects("DEVICE_FAULTED", { action: "start", code: "RUNTIME_FAILURE" })).toEqual([
      {
        kind: "RAISE",
        deviceId: "dev-1",
        code: RUNTIME_FAULT_ALARM,
        severity: "CRITICAL",
        message: "PLC runtime fault during start",
      },
    ]);
    expect(effects("DEVICE_FAULTED", { state: "FAULTED" })[0]).toMatchObject({ message: "PLC runtime fault" });
    for (const type of ["DEVICE_RUNNING", "DEVICE_STOPPED", "DEVICE_STARTING"]) {
      expect(effects(type, { state: "RUNNING" })).toEqual([
        { kind: "CLEAR", deviceId: "dev-1", code: RUNTIME_FAULT_ALARM },
      ]);
    }
    expect(effects("DEVICE_STATE_CHANGED", { state: "DEGRADED" })).toEqual([
      { kind: "CLEAR", deviceId: "dev-1", code: RUNTIME_FAULT_ALARM },
    ]);
  });

  it("lets only the tag monitor's link raise the PLC link alarm", () => {
    expect(effects("CONNECTION_DOWN", { link: "tag-monitor" })).toEqual([
      expect.objectContaining({ kind: "RAISE", code: PLC_LINK_ALARM, severity: "WARNING" }),
    ]);
    expect(effects("CONNECTION_UP", { link: "tag-monitor" })).toEqual([
      { kind: "CLEAR", deviceId: "dev-1", code: PLC_LINK_ALARM },
    ]);
    expect(effects("CONNECTION_DOWN", { link: "device-simulator" })).toEqual([]);
    expect(effects("CONNECTION_UP", { link: "device-simulator" })).toEqual([]);
  });

  it("ends the simulated faults when the simulation stops, and causes nothing for alarm events themselves", () => {
    expect(effects("SIMULATION_STOPPED", { devices: 3 }, null)).toEqual([{ kind: "CLEAR_SIMULATION" }]);
    for (const type of [
      "ALARM_RAISED",
      "ALARM_CLEARED",
      "ALARM_ACKNOWLEDGED",
      "COMMAND_ACCEPTED",
      "PLC_PROGRAM_DEPLOYED",
    ]) {
      expect(effects(type, { code: "X" })).toEqual([]);
    }
    // An event without what its rule needs changes nothing.
    expect(effects("FAULT_INJECTED", {})).toEqual([]);
    expect(effects("FAULT_INJECTED", { code: "X" }, null)).toEqual([]);
  });

  it("names the four states of an alarm", () => {
    const at = new Date();
    expect(alarmState({ clearedAt: null, acknowledgedAt: null })).toBe("ACTIVE_UNACKNOWLEDGED");
    expect(alarmState({ clearedAt: null, acknowledgedAt: at })).toBe("ACTIVE_ACKNOWLEDGED");
    expect(alarmState({ clearedAt: at, acknowledgedAt: null })).toBe("CLEARED_UNACKNOWLEDGED");
    expect(alarmState({ clearedAt: at, acknowledgedAt: at })).toBe("CLEARED");
    expect(alarmCodeLabel("FAULT:OVERCURRENT")).toBe("OVERCURRENT");
    expect(alarmCodeLabel("TAG:HighPressure")).toBe("HighPressure");
    expect(alarmCodeLabel("RUNTIME_FAULT")).toBe("RUNTIME_FAULT");
  });
});

describe("live values", () => {
  const reading = (overrides: Partial<LiveTagReading> = {}): LiveTagReading => ({
    plcId: "plc-1",
    name: "Pressure",
    value: 2.5,
    quality: "GOOD",
    readAt: "2026-10-05T05:00:00.000Z",
    ...overrides,
  });
  const at = (seconds: number) => Date.parse("2026-10-05T05:00:00.000Z") + seconds * 1000;

  it("shows a good value as stale once nothing has confirmed it for a while", () => {
    expect(qualityAt(reading(), at(1), 5000)).toBe("GOOD");
    expect(qualityAt(reading(), at(5), 5000)).toBe("GOOD");
    expect(qualityAt(reading(), at(6), 5000)).toBe("STALE");
    // A quality the runtime reported is never upgraded or replaced by "stale".
    expect(qualityAt(reading({ quality: "DISCONNECTED" }), at(60), 5000)).toBe("DISCONNECTED");
    expect(qualityAt(reading({ quality: "BAD" }), at(0), 5000)).toBe("BAD");
    // A value that was never read is not good, whatever it says.
    expect(qualityAt(reading({ readAt: null }), at(0), 5000)).toBe("BAD");
  });

  it("never replaces a reading by an older one", () => {
    const known = new Map([[tagKey(reading()), reading({ value: 3, readAt: "2026-10-05T05:00:10.000Z" })]]);
    const merged = mergeReadings(known, [
      reading({ value: 1, readAt: "2026-10-05T05:00:05.000Z" }),
      reading({ name: "Flow", value: 7 }),
    ]);
    expect(merged.get("plc-1:Pressure")?.value).toBe(3);
    expect(merged.get("plc-1:Flow")?.value).toBe(7);
    // A reading without a time (the PLC is no longer read) always applies.
    expect(
      mergeReadings(merged, [reading({ value: null, quality: "DISCONNECTED", readAt: null })]).get("plc-1:Pressure"),
    ).toMatchObject({
      value: null,
      quality: "DISCONNECTED",
    });
  });

  it("confirms the good values of the PLC that answered, and only those", () => {
    const known = new Map(
      [
        reading(),
        reading({ name: "Lost", quality: "DISCONNECTED" }),
        reading({ plcId: "plc-2", name: "Other" }),
        reading({ name: "Newer", readAt: "2026-10-05T05:01:00.000Z" }),
      ].map((item) => [tagKey(item), item]),
    );
    const confirmed = confirmReadings(known, "plc-1", "2026-10-05T05:00:30.000Z");
    expect(confirmed.get("plc-1:Pressure")?.readAt).toBe("2026-10-05T05:00:30.000Z");
    expect(confirmed.get("plc-1:Lost")?.readAt).toBe("2026-10-05T05:00:00.000Z");
    expect(confirmed.get("plc-2:Other")?.readAt).toBe("2026-10-05T05:00:00.000Z");
    expect(confirmed.get("plc-1:Newer")?.readAt).toBe("2026-10-05T05:01:00.000Z");
  });

  it("applies a tags message: changed values, and freshness for the rest when the PLC answered", () => {
    const known = new Map([reading(), reading({ name: "Flow", value: 7 })].map((item) => [tagKey(item), item]));
    const message = {
      kind: "tags" as const,
      factoryId: "factory-1",
      plcId: "plc-1",
      at: "2026-10-05T05:00:20.000Z",
      readings: [reading({ value: 2.9, readAt: "2026-10-05T05:00:20.000Z" })],
    };
    const answered = applyTagMessage(known, { ...message, confirmed: true });
    expect(answered.get("plc-1:Pressure")).toMatchObject({ value: 2.9, readAt: "2026-10-05T05:00:20.000Z" });
    expect(answered.get("plc-1:Flow")).toMatchObject({ value: 7, readAt: "2026-10-05T05:00:20.000Z" });
    const silent = applyTagMessage(known, { ...message, confirmed: false });
    expect(silent.get("plc-1:Flow")?.readAt).toBe("2026-10-05T05:00:00.000Z");
  });
});
