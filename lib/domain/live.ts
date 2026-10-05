/**
 * What the live channel carries from the server to the browser (docs/events-telemetry.md
 * → UI delivery). Pure types and rules; importable anywhere.
 *
 * Live values come from runtime memory: the PLC through its tag monitor, simulated
 * devices from the simulator. A value read from the database is marked as a snapshot.
 */
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { TagQuality } from "@/lib/domain/tag";

export type LiveTagReading = {
  plcId: string;
  name: string;
  /** Engineering value; null when no value has been read yet. */
  value: number | boolean | null;
  quality: TagQuality;
  /** When the value was last read from the PLC; null when it never was. */
  readAt: string | null;
};

export type LiveDeviceState = {
  deviceId: string;
  name: string;
  status: RuntimeState;
  /**
   * Where the state comes from: `LIVE` runtime memory, `SNAPSHOT` the last persisted
   * snapshot (the runtime is not running), `STORED` the last known status only.
   */
  source: "LIVE" | "SNAPSHOT" | "STORED";
  quality: TagQuality;
  /** When the state was observed. */
  at: string | null;
};

export type LiveSnapshot = {
  factoryId: string;
  at: string;
  tags: LiveTagReading[];
  devices: LiveDeviceState[];
  activeAlarms: number;
};

export type LiveMessage =
  /** A recorded event. The only message with an id a client can resume from. */
  | { kind: "event"; event: RuntimeEventEnvelope }
  /**
   * Tag values of one PLC that changed since the last message. Not recorded as events.
   * `confirmed` says the PLC answered at `at`: its other good values are unchanged and
   * as fresh as `at`. Without it the PLC did not answer, or is no longer read.
   */
  | { kind: "tags"; factoryId: string; plcId: string; at: string; confirmed: boolean; readings: LiveTagReading[] }
  /** The whole live state, sent when a client connects or reconnects. */
  | { kind: "snapshot"; snapshot: LiveSnapshot }
  /** Proof of life while nothing else is sent. */
  | { kind: "heartbeat"; at: string }
  /** Events were missed and cannot be replayed: the client should load its lists again. */
  | { kind: "reset"; reason: "UNKNOWN_EVENT" | "TOO_MANY_EVENTS" };

export type LiveMessageKind = LiveMessage["kind"];
export const LIVE_MESSAGE_KINDS = ["event", "tags", "snapshot", "heartbeat", "reset"] as const;

/** A value older than this, with nothing newer arriving, is shown as stale. */
export const DEFAULT_STALE_AFTER_MS = 5000;
/** The stream says it is alive at least this often. */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * The quality to show for a reading right now. A good value nobody has confirmed for a
 * while is stale: it may still be right, but it is old.
 */
export function qualityAt(
  reading: Pick<LiveTagReading, "quality" | "readAt">,
  nowMs: number,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): TagQuality {
  if (reading.quality !== "GOOD") return reading.quality;
  if (reading.readAt === null) return "BAD";
  return nowMs - Date.parse(reading.readAt) > staleAfterMs ? "STALE" : "GOOD";
}

/** `tag:<plcId>:<name>`: the key a reading is known by on both sides of the stream. */
export function tagKey(reading: Pick<LiveTagReading, "plcId" | "name">): string {
  return `${reading.plcId}:${reading.name}`;
}

/** A PLC answered at `at`: its good values are known to be current as of then. */
export function confirmReadings(
  known: ReadonlyMap<string, LiveTagReading>,
  plcId: string,
  at: string,
): Map<string, LiveTagReading> {
  const next = new Map(known);
  for (const [key, reading] of known) {
    const newer = reading.readAt !== null && Date.parse(reading.readAt) >= Date.parse(at);
    if (reading.plcId === plcId && reading.quality === "GOOD" && !newer) next.set(key, { ...reading, readAt: at });
  }
  return next;
}

/** Applies a `tags` message to the known readings. */
export function applyTagMessage(
  known: ReadonlyMap<string, LiveTagReading>,
  message: Extract<LiveMessage, { kind: "tags" }>,
): Map<string, LiveTagReading> {
  const merged = mergeReadings(known, message.readings);
  return message.confirmed ? confirmReadings(merged, message.plcId, message.at) : merged;
}

/** Folds changed readings into the known ones; a reading never replaces a newer one. */
export function mergeReadings(
  known: ReadonlyMap<string, LiveTagReading>,
  readings: readonly LiveTagReading[],
): Map<string, LiveTagReading> {
  const next = new Map(known);
  for (const reading of readings) {
    const key = tagKey(reading);
    const current = next.get(key);
    const older =
      current?.readAt != null && reading.readAt != null && Date.parse(reading.readAt) < Date.parse(current.readAt);
    if (!older) next.set(key, reading);
  }
  return next;
}
