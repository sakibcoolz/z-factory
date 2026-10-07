import "server-only";
import {
  advanceLatest,
  DAY_MS,
  dayKey,
  dayStart,
  type Latest,
  type Quality,
  type StoredValue,
} from "@/lib/domain/telemetry";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/**
 * Where telemetry goes (TASK-903, ADR-0020). The interface is what the ingestion pipeline
 * and the query services use, so a dedicated time-series engine can take the history over
 * later; PostgreSQL is the first implementation.
 *
 * PostgreSQL layout:
 * - telemetry.batch and telemetry.sample: the history, partitioned by UTC day. A day
 *   partition is created when the first batch of that day arrives; partitions older than
 *   the retention are dropped whole.
 * - "TagLatest" and "PlcEvent" (Prisma): the latest value of each tag, and quality changes.
 */

/** A batch ready to store: its PLC known, its values matched to registered tags. */
export type ResolvedBatch = {
  plcId: string;
  at: Date;
  receivedAt: Date;
  configVersion: number;
  replayed: boolean;
  values: Array<{ tag: string; quality: Quality } & StoredValue>;
};

export type WriteResult = { batches: number; duplicates: number; samples: number; events: number };

export type Sample = { at: Date; quality: string; value: number | boolean | null };

export type Bucket = {
  at: Date;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  /** The last value of the bucket (numbers and booleans alike) and the worst quality in it. */
  last: number | boolean | null;
  quality: string;
};

export type HistoryQuery = { plcId: string; tag: string; from: Date; to: Date; limit: number };

export interface TelemetryStore {
  /** Stores batches; a batch already stored (same PLC and time) is a duplicate and changes nothing. */
  write(batches: ResolvedBatch[]): Promise<WriteResult>;
  /** Raw samples of one tag, oldest first. */
  history(query: HistoryQuery): Promise<Sample[]>;
  /** One tag aggregated into buckets of `bucketMs`, oldest first. */
  aggregate(query: HistoryQuery & { bucketMs: number }): Promise<Bucket[]>;
  /** Creates the day partitions around `now` and drops those older than the retention. */
  maintain(now: Date, retentionDays: number): Promise<{ created: string[]; dropped: string[] }>;
}

const TABLES = ["batch", "sample"] as const;
const PARTITION = /^(batch|sample)_d(\d{8})$/;

export class PostgresTelemetryStore implements TelemetryStore {
  /** Days whose partitions are known to exist. */
  private readonly days = new Set<string>();
  private creating: Promise<void> = Promise.resolve();

  constructor(private readonly db: PrismaClient) {}

  /** Makes sure the day partitions of these times exist; one creation at a time. */
  async ensureDays(times: Date[]): Promise<string[]> {
    const missing = [...new Set(times.map(dayKey))].filter((day) => !this.days.has(day));
    if (missing.length === 0) return [];
    const created: string[] = [];
    const work = this.creating.then(async () => {
      for (const day of missing) {
        if (this.days.has(day)) continue;
        const from = new Date(Date.UTC(+day.slice(0, 4), +day.slice(4, 6) - 1, +day.slice(6, 8)));
        const to = new Date(from.getTime() + DAY_MS);
        for (const table of TABLES) {
          // Names and bounds come from a date, never from input.
          await this.db.$executeRawUnsafe(
            `CREATE TABLE IF NOT EXISTS telemetry.${table}_d${day} PARTITION OF telemetry.${table} ` +
              `FOR VALUES FROM ('${from.toISOString()}') TO ('${to.toISOString()}')`,
          );
        }
        this.days.add(day);
        created.push(day);
      }
    });
    this.creating = work.catch(() => {});
    await work;
    return created;
  }

  async write(batches: ResolvedBatch[]): Promise<WriteResult> {
    if (batches.length === 0) return { batches: 0, duplicates: 0, samples: 0, events: 0 };
    await this.ensureDays(batches.map((batch) => batch.at));
    return this.db.$transaction(async (tx) => {
      // 1. The batch keys: what is already there is a duplicate.
      const inserted = await tx.$queryRawUnsafe<Array<{ plc_id: string; at: Date }>>(
        `INSERT INTO telemetry.batch (plc_id, at, received_at, config_version, replayed, value_count)
         SELECT * FROM unnest($1::uuid[], $2::timestamptz[], $3::timestamptz[], $4::int[], $5::bool[], $6::int[])
         ON CONFLICT DO NOTHING RETURNING plc_id, at`,
        batches.map((batch) => batch.plcId),
        batches.map((batch) => batch.at),
        batches.map((batch) => batch.receivedAt),
        batches.map((batch) => batch.configVersion),
        batches.map((batch) => batch.replayed),
        batches.map((batch) => batch.values.length),
      );
      const fresh = new Set(inserted.map((row) => `${row.plc_id}|${new Date(row.at).getTime()}`));
      const kept = batches.filter((batch) => fresh.has(`${batch.plcId}|${batch.at.getTime()}`));
      const result: WriteResult = {
        batches: kept.length,
        duplicates: batches.length - kept.length,
        samples: 0,
        events: 0,
      };
      if (kept.length === 0) return result;

      // 2. The samples.
      const rows = kept.flatMap((batch) => batch.values.map((value) => ({ batch, value })));
      if (rows.length > 0) {
        result.samples = await tx.$executeRawUnsafe(
          `INSERT INTO telemetry.sample (plc_id, tag, at, value_num, value_bool, quality)
           SELECT * FROM unnest($1::uuid[], $2::text[], $3::timestamptz[], $4::float8[], $5::bool[], $6::text[])
           ON CONFLICT DO NOTHING`,
          rows.map((row) => row.batch.plcId),
          rows.map((row) => row.value.tag),
          rows.map((row) => row.batch.at),
          rows.map((row) => row.value.num),
          rows.map((row) => row.value.bool),
          rows.map((row) => row.value.quality),
        );
      }

      // 3. Latest values and quality changes, PLC by PLC, from the locked latest rows.
      const byPlc = new Map<string, ResolvedBatch[]>();
      for (const batch of kept) byPlc.set(batch.plcId, [...(byPlc.get(batch.plcId) ?? []), batch]);
      for (const [plcId, plcBatches] of byPlc) {
        const current = await tx.$queryRawUnsafe<
          Array<{ tag: string; quality: string; at: Date; valueNum: number | null; valueBool: boolean | null }>
        >(
          `SELECT "tag", "quality", "at", "valueNum", "valueBool" FROM "TagLatest" WHERE "plcId" = $1::uuid FOR UPDATE`,
          plcId,
        );
        const stored = new Map<string, Latest>(
          current.map((row) => [
            row.tag,
            {
              tag: row.tag,
              quality: row.quality as Quality,
              at: new Date(row.at),
              num: row.valueNum,
              bool: row.valueBool,
            },
          ]),
        );
        const { latest, changed, changes } = advanceLatest(stored, plcBatches);
        const newest = plcBatches.reduce((a, b) => (a.at > b.at ? a : b));
        const updates = [...changed].map((tag) => latest.get(tag)!);
        if (updates.length > 0) {
          await tx.$executeRawUnsafe(
            `INSERT INTO "TagLatest" ("plcId", "tag", "valueNum", "valueBool", "quality", "at", "receivedAt", "configVersion")
             SELECT $1::uuid, * FROM unnest($2::text[], $3::float8[], $4::bool[], $5::text[], $6::timestamp[], $7::timestamp[], $8::int[])
             ON CONFLICT ("plcId", "tag") DO UPDATE SET
               "valueNum" = excluded."valueNum", "valueBool" = excluded."valueBool", "quality" = excluded."quality",
               "at" = excluded."at", "receivedAt" = excluded."receivedAt", "configVersion" = excluded."configVersion"
             WHERE "TagLatest"."at" < excluded."at"`,
            plcId,
            updates.map((value) => value.tag),
            updates.map((value) => value.num),
            updates.map((value) => value.bool),
            updates.map((value) => value.quality),
            updates.map((value) => value.at),
            updates.map(() => newest.receivedAt),
            updates.map(() => newest.configVersion),
          );
        }
        if (changes.length > 0) {
          const { count } = await tx.plcEvent.createMany({
            data: changes.map((change) => ({
              plcId,
              kind: "TAG_QUALITY" as const,
              subject: change.tag,
              fromValue: change.from,
              toValue: change.to,
              at: change.at,
            })),
            skipDuplicates: true,
          });
          result.events += count;
        }
      }
      return result;
    });
  }

  async history({ plcId, tag, from, to, limit }: HistoryQuery): Promise<Sample[]> {
    const rows = await this.db.$queryRawUnsafe<
      Array<{ at: Date; quality: string; value_num: number | null; value_bool: boolean | null }>
    >(
      `SELECT at, quality, value_num, value_bool FROM telemetry.sample
       WHERE plc_id = $1::uuid AND tag = $2 AND at >= $3 AND at < $4 ORDER BY at LIMIT $5`,
      plcId,
      tag,
      from,
      to,
      limit,
    );
    return rows.map((row) => ({ at: new Date(row.at), quality: row.quality, value: row.value_bool ?? row.value_num }));
  }

  async aggregate({ plcId, tag, from, to, limit, bucketMs }: HistoryQuery & { bucketMs: number }): Promise<Bucket[]> {
    const rows = await this.db.$queryRawUnsafe<
      Array<{
        bucket: Date;
        count: bigint;
        min: number | null;
        max: number | null;
        avg: number | null;
        last_num: number | null;
        last_bool: boolean | null;
        quality: string;
      }>
    >(
      `SELECT date_bin(make_interval(secs => $5::float8 / 1000), at, $3::timestamptz) AS bucket,
              count(*) AS count,
              min(value_num) AS min, max(value_num) AS max, avg(value_num) AS avg,
              (array_agg(value_num ORDER BY at DESC))[1] AS last_num,
              (array_agg(value_bool ORDER BY at DESC))[1] AS last_bool,
              CASE WHEN bool_or(quality = 'DISCONNECTED') THEN 'DISCONNECTED'
                   WHEN bool_or(quality = 'BAD') THEN 'BAD'
                   WHEN bool_or(quality = 'STALE') THEN 'STALE' ELSE 'GOOD' END AS quality
       FROM telemetry.sample
       WHERE plc_id = $1::uuid AND tag = $2 AND at >= $3 AND at < $4
       GROUP BY 1 ORDER BY 1 LIMIT $6`,
      plcId,
      tag,
      from,
      to,
      bucketMs,
      limit,
    );
    return rows.map((row) => ({
      at: new Date(row.bucket),
      count: Number(row.count),
      min: row.min,
      max: row.max,
      avg: row.avg === null ? null : Number(row.avg),
      last: row.last_bool ?? row.last_num,
      quality: row.quality,
    }));
  }

  async maintain(now: Date, retentionDays: number): Promise<{ created: string[]; dropped: string[] }> {
    // Today and tomorrow are ready before their first batch.
    const created = await this.ensureDays([now, new Date(now.getTime() + DAY_MS)]);
    const oldestKept = dayKey(new Date(dayStart(now).getTime() - (retentionDays - 1) * DAY_MS));
    const partitions = await this.db.$queryRawUnsafe<Array<{ name: string }>>(
      `SELECT c.relname AS name FROM pg_inherits i
       JOIN pg_class c ON c.oid = i.inhrelid JOIN pg_class p ON p.oid = i.inhparent
       JOIN pg_namespace n ON n.oid = p.relnamespace
       WHERE n.nspname = 'telemetry' AND p.relname IN ('batch', 'sample')`,
    );
    const dropped: string[] = [];
    for (const { name } of partitions) {
      const match = PARTITION.exec(name);
      if (!match || match[2]! >= oldestKept) continue;
      await this.db.$executeRawUnsafe(`DROP TABLE IF EXISTS telemetry.${name}`);
      this.days.delete(match[2]!);
      dropped.push(name);
    }
    return { created, dropped: dropped.sort() };
  }
}
