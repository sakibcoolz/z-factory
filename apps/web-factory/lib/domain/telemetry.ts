import { z } from "zod";
import { TOPIC_SEGMENT } from "./agent-messages";

/**
 * Telemetry as the agent publishes it on zfactory/{site}/{agent}/telemetry/{plcId}
 * (`zfactory.telemetry` version 1: one poll of one PLC), and what Web Factory makes of it
 * (TASK-903, ADR-0020). Pure; importable anywhere.
 *
 * A batch has no message id. Its identity is the PLC and the poll time: the agent stamps
 * every value of one poll with the same `at`, and a batch replayed from its spool keeps
 * it. So (PLC, at) is the key that makes a redelivered or replayed batch a duplicate.
 */

/** What the agent says about a value. STALE and DISCONNECTED are also projected on read. */
export const QUALITIES = ["GOOD", "BAD", "STALE", "DISCONNECTED"] as const;
export type Quality = (typeof QUALITIES)[number];

const time = z.coerce.date().refine((value) => !Number.isNaN(value.getTime()), "not a time");

export const telemetryValueSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().max(200).optional(),
  value: z.union([z.number().finite(), z.boolean(), z.null()]),
  quality: z.enum(QUALITIES),
  at: time.optional(),
});

export const telemetryBatchSchema = z.object({
  schema: z.literal("zfactory.telemetry"),
  version: z.literal(1),
  siteId: z.string().regex(TOPIC_SEGMENT),
  agentId: z.string().regex(TOPIC_SEGMENT),
  replayed: z.boolean().optional(),
  plcId: z.string().regex(TOPIC_SEGMENT),
  configVersion: z.number().int().min(0).max(2_147_483_647),
  at: time,
  values: z.array(telemetryValueSchema).max(5000),
});

export type TelemetryBatchMessage = z.infer<typeof telemetryBatchSchema>;
export type TelemetryValue = z.infer<typeof telemetryValueSchema>;

/** A value as stored: a number, a boolean, or neither when the tag was never read. */
export type StoredValue = { num: number | null; bool: boolean | null };

export function storedValue(value: number | boolean | null): StoredValue {
  if (typeof value === "boolean") return { num: null, bool: value };
  if (typeof value === "number") return { num: value, bool: null };
  return { num: null, bool: null };
}

export function shownValue(stored: StoredValue): number | boolean | null {
  return stored.bool ?? stored.num;
}

/** One tag's newest value, as the latest-state view keeps it. */
export type Latest = { tag: string; quality: Quality; at: Date } & StoredValue;

/** A quality change of a tag, recorded as an event. */
export type QualityChange = { tag: string; from: Quality | null; to: Quality; at: Date };

/**
 * Walks batches of one PLC in time order from the stored latest values and returns the
 * new latest values and the quality changes on the way. A batch not newer than a tag's
 * latest value leaves that tag alone, so the result does not depend on the order batches
 * arrive in, and a replayed or duplicated batch changes nothing.
 */
export function advanceLatest(
  stored: ReadonlyMap<string, Latest>,
  batches: ReadonlyArray<{ at: Date; values: ReadonlyArray<{ tag: string; quality: Quality } & StoredValue> }>,
): { latest: Map<string, Latest>; changed: Set<string>; changes: QualityChange[] } {
  const latest = new Map(stored);
  const changed = new Set<string>();
  const changes: QualityChange[] = [];
  const ordered = [...batches].sort((a, b) => a.at.getTime() - b.at.getTime());
  for (const batch of ordered) {
    for (const value of batch.values) {
      const before = latest.get(value.tag);
      if (before && before.at.getTime() >= batch.at.getTime()) continue;
      if (!before || before.quality !== value.quality) {
        changes.push({ tag: value.tag, from: before?.quality ?? null, to: value.quality, at: batch.at });
      }
      latest.set(value.tag, { tag: value.tag, quality: value.quality, at: batch.at, num: value.num, bool: value.bool });
      changed.add(value.tag);
    }
  }
  return { latest, changed, changes };
}

/** A value is stale when nobody confirmed it for three poll intervals (the agent's rule). */
export const STALE_AFTER_POLLS = 3;

/**
 * The quality a page shows: DISCONNECTED while the PLC's connection is not up (as its
 * agent reports it, or because the agent itself is unreachable), STALE when the value was
 * not refreshed for three poll intervals, otherwise what the agent sent.
 */
export function projectQuality(
  latest: { quality: Quality; at: Date },
  plcConnection: string,
  pollIntervalMs: number,
  now: Date,
): Quality {
  if (plcConnection !== "ONLINE" && plcConnection !== "DEGRADED") return "DISCONNECTED";
  if (latest.quality === "DISCONNECTED") return "DISCONNECTED";
  if (now.getTime() - latest.at.getTime() > STALE_AFTER_POLLS * pollIntervalMs) return "STALE";
  return latest.quality;
}

/** Day partitions (UTC) of the telemetry history. */
export const DAY_MS = 86_400_000;

export const dayStart = (at: Date) => new Date(Math.floor(at.getTime() / DAY_MS) * DAY_MS);

/** e.g. 20261007 for 2026-10-07. */
export const dayKey = (at: Date) => dayStart(at).toISOString().slice(0, 10).replaceAll("-", "");

/** Why a batch is not stored: older than the retention, or too far in the future (a wrong clock). */
export function batchTimeProblem(
  at: Date,
  now: Date,
  retentionDays: number,
  futureToleranceMs = 10 * 60_000,
): "expired" | "future" | null {
  if (at.getTime() > now.getTime() + futureToleranceMs) return "future";
  if (at.getTime() < dayStart(now).getTime() - (retentionDays - 1) * DAY_MS) return "expired";
  return null;
}
