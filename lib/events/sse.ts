import "server-only";
import type { LiveMessage } from "@/lib/domain/live";

/**
 * Server-sent events wire format. Only recorded events carry an `id`: it is what a
 * browser sends back as `Last-Event-ID` when it reconnects, and only recorded events
 * can be replayed. Tag values and snapshots leave that id untouched.
 */
export function encodeSse(message: LiveMessage): string {
  const data = message.kind === "event" ? message.event : message;
  const id = message.kind === "event" ? `id: ${message.event.id}\n` : "";
  // JSON never contains a raw line break, so one `data:` line carries the whole message.
  return `event: ${message.kind}\n${id}data: ${JSON.stringify(data)}\n\n`;
}

/** How long a browser waits before it reconnects, in milliseconds. */
export const SSE_RETRY_MS = 3000;

export const sseRetry = () => `retry: ${SSE_RETRY_MS}\n\n`;
