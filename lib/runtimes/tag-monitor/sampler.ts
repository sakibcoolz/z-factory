import "server-only";
import type { TagQuality } from "@/lib/domain/tag";

/**
 * Decides which live values become stored telemetry (docs/events-telemetry.md →
 * Persistence rules). A PLC is read several times a second; a sample is stored only when
 * the value has moved noticeably, when its quality changed, or as a sign of life.
 */

export type SamplingPolicy = {
  /** A tag is never stored more often than this, however much it moves. */
  minIntervalMs: number;
  /** A tag is stored at least this often even when it does not move. */
  maxIntervalMs: number;
  /** A change smaller than this share of the last stored value is not stored. */
  deadbandRatio: number;
};

export const DEFAULT_SAMPLING_POLICY: SamplingPolicy = {
  minIntervalMs: 1000,
  maxIntervalMs: 60_000,
  deadbandRatio: 0.01,
};

export type StoredSample = { value: number; quality: TagQuality; atMs: number };

/**
 * `resolution` is the smallest step the tag can show (its scale, 1 for a BOOL): a change
 * below it is noise, and around zero the relative deadband alone would store everything.
 */
export function shouldStore(
  last: StoredSample | undefined,
  next: { value: number; quality: TagQuality },
  nowMs: number,
  policy: SamplingPolicy,
  resolution: number,
): boolean {
  if (!last) return true;
  if (next.quality !== last.quality) return true;
  const elapsed = nowMs - last.atMs;
  if (elapsed >= policy.maxIntervalMs) return true;
  if (elapsed < policy.minIntervalMs) return false;
  const deadband = Math.max(Math.abs(last.value) * policy.deadbandRatio, Math.abs(resolution));
  return Math.abs(next.value - last.value) >= deadband;
}

/** The number a reading is stored as; a BOOL is 0 or 1. */
export function sampleValue(value: number | boolean | null): number | null {
  if (value === null) return null;
  if (typeof value === "boolean") return value ? 1 : 0;
  return Number.isFinite(value) ? value : null;
}
