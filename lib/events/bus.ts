import "server-only";
import type { RuntimeEventEnvelope } from "@/lib/domain/events";

type Listener = (event: RuntimeEventEnvelope) => void;

/**
 * In-process event bus. Runtimes publish here; transports (SSE) and other listeners
 * subscribe. It holds no history: persisted events live in `RuntimeEvent`.
 */
export class EventBus {
  private readonly listeners = new Set<Listener>();

  /** Returns the function that removes the listener again. */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: RuntimeEventEnvelope): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // One failing listener must not keep the event from the others.
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
