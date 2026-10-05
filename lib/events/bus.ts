import "server-only";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";
import type { LiveMessage } from "@/lib/domain/live";

type Listener = (event: RuntimeEventEnvelope) => void;
type LiveListener = (message: LiveMessage) => void;

/**
 * In-process event bus. Runtimes publish here; transports (SSE) and other listeners
 * subscribe. It holds no history: persisted events live in `RuntimeEvent`.
 *
 * Two kinds of traffic: recorded events, and live messages of one factory (tag values,
 * which are not events). A recorded event reaches both kinds of listener.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();
  private readonly liveListeners = new Map<string, Set<LiveListener>>();

  /** Returns the function that removes the listener again. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Everything live of one factory: its recorded events and its tag values. */
  subscribeLive(factoryId: string, listener: LiveListener): () => void {
    const listeners = this.liveListeners.get(factoryId) ?? new Set<LiveListener>();
    listeners.add(listener);
    this.liveListeners.set(factoryId, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.liveListeners.delete(factoryId);
    };
  }

  /** How many live listeners a factory has, e.g. open browser streams. */
  liveListenerCount(factoryId: string): number {
    return this.liveListeners.get(factoryId)?.size ?? 0;
  }

  publish(event: RuntimeEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One failing listener must not keep the event from the others.
      }
    }
    this.publishLive(event.factoryId, { kind: "event", event });
  }

  publishLive(factoryId: string, message: LiveMessage): void {
    for (const listener of this.liveListeners.get(factoryId) ?? []) {
      try {
        listener(message);
      } catch {
        // As above.
      }
    }
  }
}

const globalBus = globalThis as typeof globalThis & { zfactoryEventBus?: EventBus };

/** The bus of this server process (kept across development reloads). */
export function getEventBus(): EventBus {
  globalBus.zfactoryEventBus ??= new EventBus();
  return globalBus.zfactoryEventBus;
}
