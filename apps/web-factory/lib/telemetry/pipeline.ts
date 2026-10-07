import "server-only";
import { batchTimeProblem, storedValue, type TelemetryBatchMessage } from "@/lib/domain/telemetry";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { ResolvedBatch, TelemetryStore } from "./store";

/**
 * The telemetry ingestion pipeline (TASK-903). The MQTT handler offers batches; a fixed
 * number of writers take them off bounded queues and store them in groups.
 *
 * - Bounded: each writer has a queue of `capacity / writers` batches. When it is full the
 *   oldest batch is dropped and counted (a newer reading is worth more), so memory stays
 *   bounded and the broker connection is never held up.
 * - Ordered: a PLC always goes to the same writer, so its batches are stored in the order
 *   they arrived.
 * - Grouped: a writer stores up to `groupSize` batches in one transaction.
 * - A batch is matched to its registered PLC and tags; values of tags that are not
 *   registered are counted and skipped, and batches older than the retention or from the
 *   future are dropped.
 */

export type TelemetryOffer = {
  agentId: string;
  message: TelemetryBatchMessage;
  receivedAt: Date;
};

export type TelemetryDrop = "overload" | "unknown-plc" | "expired" | "future";

export type TelemetryStats = {
  offered: number;
  queued: number;
  capacity: number;
  stored: number;
  duplicates: number;
  samples: number;
  events: number;
  unknownTags: number;
  versionMismatches: number;
  errors: number;
  dropped: Record<TelemetryDrop, number>;
  lastWriteMs: number | null;
  lastWriteAt: string | null;
};

export type PipelineOptions = {
  capacity?: number;
  writers?: number;
  groupSize?: number;
  retentionDays?: number;
  /** How long a registered PLC's tags are remembered before they are looked up again. */
  plcCacheMs?: number;
  now?: () => Date;
  onError?: (error: unknown) => void;
};

type PlcInfo = { id: string; configVersion: number; tags: Set<string> } | null;

type Queue = { items: TelemetryOffer[]; running: Promise<void> | null };

export class TelemetryPipeline {
  private readonly queues: Queue[];
  private readonly capacity: number;
  private readonly groupSize: number;
  private readonly retentionDays: number;
  private readonly plcCacheMs: number;
  private readonly now: () => Date;
  private readonly plcs = new Map<string, { info: PlcInfo; until: number }>();
  private stopped = false;
  readonly stats: TelemetryStats;

  constructor(
    private readonly db: PrismaClient,
    private readonly store: TelemetryStore,
    private readonly options: PipelineOptions = {},
  ) {
    const writers = Math.max(1, options.writers ?? 2);
    this.capacity = Math.max(writers, options.capacity ?? 10_000);
    this.groupSize = Math.max(1, options.groupSize ?? 200);
    this.retentionDays = options.retentionDays ?? 30;
    this.plcCacheMs = options.plcCacheMs ?? 30_000;
    this.now = options.now ?? (() => new Date());
    this.queues = Array.from({ length: writers }, () => ({ items: [], running: null }));
    this.stats = {
      offered: 0,
      queued: 0,
      capacity: this.capacity,
      stored: 0,
      duplicates: 0,
      samples: 0,
      events: 0,
      unknownTags: 0,
      versionMismatches: 0,
      errors: 0,
      dropped: { overload: 0, "unknown-plc": 0, expired: 0, future: 0 },
      lastWriteMs: null,
      lastWriteAt: null,
    };
  }

  /** Takes a batch; never blocks. */
  offer(offer: TelemetryOffer): void {
    if (this.stopped) return;
    this.stats.offered += 1;
    const queue = this.queues[this.shard(`${offer.agentId}/${offer.message.plcId}`)]!;
    const perQueue = Math.ceil(this.capacity / this.queues.length);
    if (queue.items.length >= perQueue) {
      queue.items.shift();
      this.stats.dropped.overload += 1;
      this.stats.queued -= 1;
    }
    queue.items.push(offer);
    this.stats.queued += 1;
    if (!queue.running) queue.running = this.drain(queue);
  }

  /** Resolves when every batch offered so far is stored (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.queues.some((queue) => queue.running)) {
      await Promise.all(this.queues.map((queue) => queue.running));
    }
  }

  async stop(): Promise<void> {
    await this.idle();
    this.stopped = true;
  }

  /** Forgets a PLC's cached tags, e.g. after a new registration. */
  forgetPlcs(): void {
    this.plcs.clear();
  }

  private shard(key: string): number {
    let hash = 0;
    for (let index = 0; index < key.length; index += 1) hash = (hash * 31 + key.charCodeAt(index)) | 0;
    return Math.abs(hash) % this.queues.length;
  }

  private async drain(queue: Queue): Promise<void> {
    try {
      while (queue.items.length > 0) {
        const group = queue.items.splice(0, this.groupSize);
        this.stats.queued -= group.length;
        try {
          const resolved = await this.resolve(group);
          if (resolved.length === 0) continue;
          const started = performance.now();
          const result = await this.store.write(resolved);
          this.stats.lastWriteMs = Math.round(performance.now() - started);
          this.stats.lastWriteAt = this.now().toISOString();
          this.stats.stored += result.batches;
          this.stats.duplicates += result.duplicates;
          this.stats.samples += result.samples;
          this.stats.events += result.events;
        } catch (error) {
          this.stats.errors += 1;
          this.options.onError?.(error);
        }
      }
    } finally {
      queue.running = null;
    }
  }

  private async plc(agentId: string, externalPlcId: string): Promise<PlcInfo> {
    const key = `${agentId}/${externalPlcId}`;
    const cached = this.plcs.get(key);
    if (cached && cached.until > Date.now()) return cached.info;
    const row = await this.db.plc.findUnique({
      where: { edgeAgentId_externalPlcId: { edgeAgentId: agentId, externalPlcId } },
      select: { id: true, configVersion: true, mappings: { select: { externalId: true } } },
    });
    const info = row
      ? { id: row.id, configVersion: row.configVersion, tags: new Set(row.mappings.map((m) => m.externalId)) }
      : null;
    this.plcs.set(key, { info, until: Date.now() + this.plcCacheMs });
    return info;
  }

  private async resolve(group: TelemetryOffer[]): Promise<ResolvedBatch[]> {
    const now = this.now();
    const resolved: ResolvedBatch[] = [];
    for (const { agentId, message, receivedAt } of group) {
      const problem = batchTimeProblem(message.at, now, this.retentionDays);
      if (problem) {
        this.stats.dropped[problem] += 1;
        continue;
      }
      const plc = await this.plc(agentId, message.plcId);
      if (!plc) {
        this.stats.dropped["unknown-plc"] += 1;
        continue;
      }
      if (message.configVersion !== plc.configVersion) this.stats.versionMismatches += 1;
      const values: ResolvedBatch["values"] = [];
      const seen = new Set<string>();
      for (const value of message.values) {
        if (!plc.tags.has(value.id) || seen.has(value.id)) {
          this.stats.unknownTags += 1;
          continue;
        }
        seen.add(value.id);
        values.push({ tag: value.id, quality: value.quality, ...storedValue(value.value) });
      }
      resolved.push({
        plcId: plc.id,
        at: message.at,
        receivedAt,
        configVersion: message.configVersion,
        replayed: message.replayed ?? false,
        values,
      });
    }
    return resolved;
  }
}
