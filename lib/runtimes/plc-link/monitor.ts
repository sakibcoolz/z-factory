import "server-only";

/**
 * Watches the PLC-to-PLC links of factories (TASK-703). The exchange itself runs in the
 * client PLC's runtime (its Modbus master); this only observes it: each cycle the factory's
 * links are evaluated by the function the service gives, and a change of a link's quality
 * is reported once. Live state lives here; events are the history.
 */

export type LinkQuality = "GOOD" | "STALE" | "DISCONNECTED";

export type LinkCheck = {
  linkId: string;
  clientPlcId: string;
  clientName: string;
  serverName: string;
  quality: LinkQuality;
  /** Why the link is not GOOD, for people. */
  reason: string | null;
};

export type LinkHealth = LinkCheck & { since: string; checkedAt: string };

export type LinkChange = { previous: LinkQuality | null; current: LinkHealth };

type Watched = {
  evaluate: () => Promise<LinkCheck[]>;
  onChanges: (changes: LinkChange[]) => void | Promise<void>;
  health: Map<string, LinkHealth>;
  timer: ReturnType<typeof setInterval> | undefined;
  inFlight: Promise<void> | undefined;
  lastError: string | null;
};

export class PlcLinkMonitorRuntime {
  private readonly watched = new Map<string, Watched>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  isRunning(factoryId: string): boolean {
    return this.watched.has(factoryId);
  }

  start(
    factoryId: string,
    options: {
      evaluate: Watched["evaluate"];
      onChanges: Watched["onChanges"];
      pollMs?: number;
      autoTick?: boolean;
    },
  ): void {
    if (this.watched.has(factoryId)) return;
    const watched: Watched = {
      evaluate: options.evaluate,
      onChanges: options.onChanges,
      health: new Map(),
      timer: undefined,
      inFlight: undefined,
      lastError: null,
    };
    this.watched.set(factoryId, watched);
    if (options.autoTick !== false) {
      watched.timer = setInterval(() => void this.tick(factoryId), options.pollMs ?? 2000);
      // Watching must not keep the server process alive on shutdown.
      watched.timer.unref?.();
    }
  }

  stop(factoryId: string): void {
    const watched = this.watched.get(factoryId);
    if (!watched) return;
    clearInterval(watched.timer);
    this.watched.delete(factoryId);
  }

  async stopAll(): Promise<void> {
    for (const factoryId of [...this.watched.keys()]) this.stop(factoryId);
  }

  /** The last known health of every link of the factory; empty while it is not watched. */
  health(factoryId: string): LinkHealth[] {
    return [...(this.watched.get(factoryId)?.health.values() ?? [])];
  }

  lastError(factoryId: string): string | null {
    return this.watched.get(factoryId)?.lastError ?? null;
  }

  private async cycle(watched: Watched): Promise<void> {
    const at = this.now().toISOString();
    const checks = await watched.evaluate();
    const changes: LinkChange[] = [];
    const seen = new Set<string>();
    for (const check of checks) {
      seen.add(check.linkId);
      const before = watched.health.get(check.linkId);
      const current: LinkHealth = {
        ...check,
        since: before && before.quality === check.quality ? before.since : at,
        checkedAt: at,
      };
      watched.health.set(check.linkId, current);
      if (!before || before.quality !== check.quality) changes.push({ previous: before?.quality ?? null, current });
    }
    // A link that was removed or disabled is no longer watched.
    for (const linkId of [...watched.health.keys()]) if (!seen.has(linkId)) watched.health.delete(linkId);
    if (changes.length > 0) await watched.onChanges(changes);
  }

  /** One evaluation; a cycle still in flight makes the next tick a no-op. A failure is kept, never thrown. */
  async tick(factoryId: string): Promise<void> {
    const watched = this.watched.get(factoryId);
    if (!watched || watched.inFlight) return;
    watched.inFlight = this.cycle(watched)
      .then(() => {
        watched.lastError = null;
      })
      .catch((error: unknown) => {
        watched.lastError = error instanceof Error ? error.message : "link check failed";
      })
      .finally(() => {
        watched.inFlight = undefined;
      });
    await watched.inFlight;
  }
}

const globalRuntime = globalThis as typeof globalThis & { zfactoryPlcLinkMonitor?: PlcLinkMonitorRuntime };

/** The shared link monitor of this server process (kept across development reloads). */
export function getPlcLinkMonitor(): PlcLinkMonitorRuntime {
  globalRuntime.zfactoryPlcLinkMonitor ??= new PlcLinkMonitorRuntime();
  return globalRuntime.zfactoryPlcLinkMonitor;
}
