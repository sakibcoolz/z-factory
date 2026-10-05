import "server-only";
import { randomBytes } from "node:crypto";

/**
 * Identity and time of runtime events. Ids are UUID version 7 and strictly increasing
 * within one server process, even inside one millisecond, so events sort by id in the
 * order they were recorded. The stream's replay after a reconnect depends on that order.
 */

// One clock per server process, however many copies of this module the bundler makes.
const clock = globalThis as typeof globalThis & { zfactoryEventClock?: { lastMs: number; sequence: number } };
const MAX_SEQUENCE = 0xfff;

export type EventStamp = { id: string; occurredAt: string };

/** The next id with the time it encodes. A clock that steps back does not break the order. */
export function nextEventStamp(nowMs: number = Date.now()): EventStamp {
  const state = (clock.zfactoryEventClock ??= { lastMs: 0, sequence: 0 });
  if (nowMs > state.lastMs) {
    state.lastMs = nowMs;
    state.sequence = 0;
  } else if (state.sequence < MAX_SEQUENCE) {
    state.sequence += 1;
  } else {
    // More than 4096 events in one millisecond: borrow the next millisecond.
    state.lastMs += 1;
    state.sequence = 0;
  }
  const { lastMs, sequence } = state;

  const bytes = randomBytes(16);
  bytes.writeUIntBE(lastMs, 0, 6);
  bytes[6] = 0x70 | (sequence >> 8);
  bytes[7] = sequence & 0xff;
  bytes[8] = 0x80 | ((bytes[8] ?? 0) & 0x3f);
  const hex = bytes.toString("hex");
  return {
    id: `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`,
    occurredAt: new Date(lastMs).toISOString(),
  };
}
