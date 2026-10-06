import "server-only";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { type FeedbackWriter, feedbackQuality, type LiveTagReading } from "@/lib/domain/live";
import type { ModbusArea, TagQuality, TagRole } from "@/lib/domain/tag";
import { decodeValue, type Encoding } from "@/lib/protocols/modbus/codec";

/**
 * The live-tag monitor: reads the tags of running PLCs over Modbus on an interval and
 * reports what changed. It is how the server knows the values PLC logic currently holds;
 * it only reads, and never writes a tag.
 *
 * One instance per server process hosts the monitors of all PLCs. The values live in its
 * memory only. Persistence (telemetry samples, alarms) happens in its hooks.
 */

export type MonitoredTag = {
  id: string;
  name: string;
  role: TagRole;
  area: ModbusArea;
  /** Zero-based address within the area. */
  address: number;
  wordCount: number;
  encoding: Encoding;
  /** Device the tag carries a signal of, if any. */
  deviceId: string | null;
  /** The simulator that fills the tag with feedback, if one does (TASK-803). */
  writer?: FeedbackWriter | null;
};

export type TagRead = (area: ModbusArea, address: number, count: number) => Promise<Array<number | boolean>>;

export type MonitorCycle = {
  /** When the PLC was read. */
  at: Date;
  /** Whether the PLC answered. When it did, every GOOD reading is confirmed as of `at`. */
  reachable: boolean;
  /** Readings whose value or quality changed in this cycle. */
  changed: LiveTagReading[];
  all: LiveTagReading[];
};

export type MonitorHooks = {
  /** After every cycle that asked the PLC. */
  onCycle?: (plc: MonitoredPlc, cycle: MonitorCycle) => void | Promise<void>;
  /** The PLC answered after not answering, or stopped answering. */
  onLink?: (plc: MonitoredPlc, up: boolean) => void | Promise<void>;
};

export type MonitoredPlc = { plcId: string; factoryId: string; mappingVersion: number; tags: readonly MonitoredTag[] };

export type MonitorStart = MonitoredPlc & {
  read: TagRead;
  pollMs?: number;
  hooks?: MonitorHooks;
  /**
   * How the writer of a feedback tag is doing, asked in every cycle: a good read of a tag
   * whose writer is not GOOD takes the writer's quality. Without it reads stand as they are.
   */
  writerQuality?: (writer: FeedbackWriter) => TagQuality;
  /** `false`: no timer; the caller runs cycles with `tick()`. */
  autoTick?: boolean;
};

export const DEFAULT_POLL_MS = 500;
/** A PLC that does not answer is asked again after this time, not on every cycle. */
const RETRY_MS = 2000;
/**
 * A PLC counts as gone when it has not answered this many attempts in a row. One missed
 * answer is not a lost connection: the runtime is briefly away while it loads a program.
 */
const DOWN_AFTER_FAILURES = 2;

type Span = { area: ModbusArea; address: number; count: number };

const isBitArea = (area: ModbusArea) => area === "COIL" || area === "DISCRETE_INPUT";

/** Groups tags into few read requests: neighbours share one request. */
export function planReads(tags: readonly MonitoredTag[]): Span[] {
  const spans: Span[] = [];
  for (const area of ["COIL", "DISCRETE_INPUT", "HOLDING_REGISTER", "INPUT_REGISTER"] as const) {
    const limit = isBitArea(area) ? 2000 : 125;
    const gap = isBitArea(area) ? 64 : 16;
    let current: Span | undefined;
    for (const tag of tags.filter((candidate) => candidate.area === area).sort((a, b) => a.address - b.address)) {
      const end = tag.address + tag.wordCount;
      if (current && tag.address <= current.address + current.count + gap && end - current.address <= limit) {
        current.count = Math.max(current.count, end - current.address);
      } else {
        current = { area, address: tag.address, count: tag.wordCount };
        spans.push(current);
      }
    }
  }
  return spans;
}

type Running = MonitoredPlc & {
  read: TagRead;
  hooks: MonitorHooks;
  writerQuality: MonitorStart["writerQuality"];
  spans: Span[];
  pollMs: number;
  timer: ReturnType<typeof setInterval> | undefined;
  inFlight: Promise<void> | undefined;
  readings: Map<string, LiveTagReading>;
  /** The link as last reported; undefined until there is something to report. */
  up: boolean | undefined;
  /** Attempts in a row the PLC did not answer. */
  failures: number;
  retryAt: number;
  cycles: number;
  lastError: string | null;
};

export type MonitorClock = { now: () => number; date: () => Date };

export class TagMonitorRuntime {
  private readonly running = new Map<string, Running>();

  constructor(private readonly clock: MonitorClock = { now: () => performance.now(), date: () => new Date() }) {}

  isRunning(plcId: string): boolean {
    return this.running.has(plcId);
  }

  /** The mapping version a running monitor was started with; undefined when it is not running. */
  mappingVersion(plcId: string): number | undefined {
    return this.running.get(plcId)?.mappingVersion;
  }

  monitored(): MonitoredPlc[] {
    return [...this.running.values()];
  }

  start(config: MonitorStart): void {
    if (this.running.has(config.plcId)) {
      throw new DomainError("CONFLICT", "The tags of this PLC are already monitored.", { rule: "monitor-running" });
    }
    const running: Running = {
      plcId: config.plcId,
      factoryId: config.factoryId,
      mappingVersion: config.mappingVersion,
      tags: config.tags,
      read: config.read,
      hooks: config.hooks ?? {},
      writerQuality: config.writerQuality,
      spans: planReads(config.tags),
      pollMs: config.pollMs ?? DEFAULT_POLL_MS,
      timer: undefined,
      inFlight: undefined,
      // Until the first cycle nothing is known about any tag.
      readings: new Map(
        config.tags.map((tag) => [
          tag.name,
          { plcId: config.plcId, name: tag.name, value: null, quality: "DISCONNECTED" as TagQuality, readAt: null },
        ]),
      ),
      up: undefined,
      failures: 0,
      retryAt: 0,
      cycles: 0,
      lastError: null,
    };
    this.running.set(config.plcId, running);
    if (config.autoTick !== false) {
      running.timer = setInterval(() => void this.tick(config.plcId), running.pollMs);
      // Monitoring must not keep the server process alive on shutdown.
      running.timer.unref?.();
    }
  }

  /** Stops reading the PLC and forgets its values. Returns the tags that were monitored. */
  async stop(plcId: string): Promise<readonly MonitoredTag[]> {
    const running = this.running.get(plcId);
    if (!running) return [];
    clearInterval(running.timer);
    this.running.delete(plcId);
    await running.inFlight;
    return running.tags;
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.running.keys()].map((plcId) => this.stop(plcId)));
  }

  /** Current readings of one PLC, straight from memory; empty when it is not monitored. */
  readings(plcId: string): LiveTagReading[] {
    return [...(this.running.get(plcId)?.readings.values() ?? [])];
  }

  readingsOfFactory(factoryId: string): LiveTagReading[] {
    return [...this.running.values()]
      .filter((running) => running.factoryId === factoryId)
      .flatMap((running) => [...running.readings.values()]);
  }

  status(plcId: string): { up: boolean | undefined; cycles: number; pollMs: number; lastError: string | null } | null {
    const running = this.running.get(plcId);
    return running
      ? { up: running.up, cycles: running.cycles, pollMs: running.pollMs, lastError: running.lastError }
      : null;
  }

  private async guard(running: Running, action: () => void | Promise<void> | undefined): Promise<void> {
    try {
      await action();
    } catch (error) {
      // Persistence trouble must not stop the reading of live values.
      running.lastError = error instanceof Error ? error.message : "hook failed";
    }
  }

  private async cycle(running: Running): Promise<void> {
    if (running.failures > 0 && this.clock.now() < running.retryAt) return;
    const at = this.clock.date();
    const readAt = at.toISOString();
    const changed: LiveTagReading[] = [];
    const set = (tag: MonitoredTag, next: Pick<LiveTagReading, "value" | "quality" | "readAt">) => {
      const current = running.readings.get(tag.name);
      const reading: LiveTagReading = { plcId: running.plcId, name: tag.name, ...next };
      running.readings.set(tag.name, reading);
      if (!current || current.value !== reading.value || current.quality !== reading.quality) changed.push(reading);
    };
    /** The value stays what it was last read as; only its quality says it can no longer be trusted. */
    const degrade = (tag: MonitoredTag, quality: TagQuality) => {
      const current = running.readings.get(tag.name);
      set(tag, { value: current?.value ?? null, quality, readAt: current?.readAt ?? null });
    };

    const writers = new Map<string, TagQuality>();
    /** A good read, as good as the tag's writer: asked once per writer and cycle. */
    const readQuality = (tag: MonitoredTag): TagQuality => {
      if (!tag.writer || !running.writerQuality) return "GOOD";
      const key = tag.writer.kind === "DEVICE" ? `d:${tag.writer.deviceId}` : `m:${tag.writer.moduleId}`;
      const known = writers.get(key) ?? running.writerQuality(tag.writer);
      writers.set(key, known);
      return feedbackQuality("GOOD", known);
    };

    let reachable = true;
    for (const span of running.spans) {
      const tags = running.tags.filter(
        (tag) => tag.area === span.area && tag.address >= span.address && tag.address < span.address + span.count,
      );
      if (!reachable) {
        tags.forEach((tag) => degrade(tag, "DISCONNECTED"));
        continue;
      }
      try {
        const raw = await running.read(span.area, span.address, span.count);
        for (const tag of tags) {
          const words = raw.slice(tag.address - span.address, tag.address - span.address + tag.wordCount);
          try {
            set(tag, { value: decodeValue(words, tag.encoding), quality: readQuality(tag), readAt });
          } catch {
            degrade(tag, "BAD");
          }
        }
      } catch (error) {
        const rule = isDomainError(error) ? String(error.details.rule) : "";
        // No answer at all: the PLC is gone, and asking for the other ranges would only wait again.
        if (/unreachable|timeout|closed/.test(rule) || !isDomainError(error)) {
          reachable = false;
          tags.forEach((tag) => degrade(tag, "DISCONNECTED"));
        } else {
          // The PLC answered but refused this range.
          tags.forEach((tag) => degrade(tag, "BAD"));
        }
      }
    }

    running.cycles += 1;
    running.lastError = null;
    running.failures = reachable ? 0 : running.failures + 1;
    running.retryAt = reachable ? 0 : this.clock.now() + RETRY_MS;
    // Values are marked at once; the link itself is reported down only when it stays down.
    const up = reachable ? true : running.failures >= DOWN_AFTER_FAILURES ? false : running.up;
    if (up !== undefined && up !== running.up) {
      running.up = up;
      await this.guard(running, () => running.hooks.onLink?.(running, up));
    }
    await this.guard(running, () =>
      running.hooks.onCycle?.(running, { at, reachable, changed, all: [...running.readings.values()] }),
    );
  }

  /** One cycle. A cycle still waiting for the PLC makes the next timer tick a no-op. */
  async tick(plcId: string): Promise<void> {
    const running = this.running.get(plcId);
    if (!running || running.inFlight) return;
    running.inFlight = this.cycle(running)
      .catch((error: unknown) => {
        running.lastError = error instanceof Error ? error.message : "monitor cycle failed";
      })
      .finally(() => {
        running.inFlight = undefined;
      });
    await running.inFlight;
  }
}

const globalRuntime = globalThis as typeof globalThis & { zfactoryTagMonitor?: TagMonitorRuntime };

/** The shared monitor of this server process (kept across development reloads). */
export function getTagMonitor(): TagMonitorRuntime {
  globalRuntime.zfactoryTagMonitor ??= new TagMonitorRuntime();
  return globalRuntime.zfactoryTagMonitor;
}
