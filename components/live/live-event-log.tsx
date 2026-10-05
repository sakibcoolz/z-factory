"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { StatePill } from "@/components/ui/state-pill";
import {
  eventDetail,
  type EventFamily,
  eventFamily,
  type EventSeverity,
  type RuntimeEventEnvelope,
} from "@/lib/domain/events";
import { STREAM_STATUS_LABEL, useFactoryStream } from "./use-factory-stream";

export type EventLogFilter = { family?: EventFamily; severity?: EventSeverity; deviceId?: string };

type LiveEventLogProps = {
  /** Recorded events, newest first, already filtered by the server. */
  events: readonly RuntimeEventEnvelope[];
  streamUrl: string;
  filter: EventLogFilter;
  /** Names for the device ids events carry. */
  deviceNames: Readonly<Record<string, string>>;
  /** Most rows kept on screen. */
  limit?: number;
};

const LEVEL = { INFO: "info", WARNING: "warn", CRITICAL: "crit" } as const;

const matches = (event: RuntimeEventEnvelope, filter: EventLogFilter) =>
  (!filter.family || eventFamily(event.type) === filter.family) &&
  (!filter.severity || event.severity === filter.severity) &&
  (!filter.deviceId || event.deviceId === filter.deviceId);

/** Newest first; events of the same millisecond keep the order of their ids. */
const newestFirst = (a: RuntimeEventEnvelope, b: RuntimeEventEnvelope) =>
  a.occurredAt === b.occurredAt ? (a.id < b.id ? 1 : -1) : a.occurredAt < b.occurredAt ? 1 : -1;

/**
 * 2m — the event stream of a stored factory: the recorded history, with new events
 * added on top as they are recorded. Alarm events also refresh the alarm list above.
 */
export function LiveEventLog({ events, streamUrl, filter, deviceNames, limit = 300 }: LiveEventLogProps) {
  const router = useRouter();
  const [received, setReceived] = useState<RuntimeEventEnvelope[]>([]);
  const refresh = useRef<ReturnType<typeof setTimeout>>(undefined);

  const status = useFactoryStream(streamUrl, (message) => {
    if (message.kind === "reset") {
      // Too much was missed to replay: read the history again.
      setReceived([]);
      router.refresh();
      return;
    }
    if (message.kind !== "event") return;
    const { event } = message;
    setReceived((known) => (known.some((item) => item.id === event.id) ? known : [event, ...known].slice(0, limit)));
    if (eventFamily(event.type) === "ALARM") {
      clearTimeout(refresh.current);
      refresh.current = setTimeout(() => router.refresh(), 300);
    }
  });
  useEffect(() => () => clearTimeout(refresh.current), []);

  const rows = useMemo(() => {
    const byId = new Map<string, RuntimeEventEnvelope>();
    for (const event of [...events, ...received]) if (matches(event, filter)) byId.set(event.id, event);
    return [...byId.values()].sort(newestFirst).slice(0, limit);
  }, [events, received, filter, limit]);

  return (
    <section className="zf-cell" data-flush="true" aria-label="Event stream">
      <h3 className="zf-cell-head justify-between">
        <span>{`Event stream · ${rows.length}`}</span>
        <StatePill tone={status === "live" ? "run" : status === "offline" ? "flt" : "deg"}>
          {STREAM_STATUS_LABEL[status]}
        </StatePill>
      </h3>
      {rows.length > 0 ? (
        <div className="zf-log" role="log">
          {rows.map((event) => {
            const detail = eventDetail(event.payload);
            return (
              <span key={event.id} className="zf-log-row">
                <span className="zf-log-ts">{`${event.occurredAt.slice(0, 10)} ${event.occurredAt.slice(11, 19)}`}</span>
                <span className="zf-log-lv" data-level={LEVEL[event.severity]}>
                  {event.severity.toLowerCase()}
                </span>
                <span className="whitespace-normal">
                  <span className="syn-type">{event.type}</span>
                  {event.deviceId ? ` ${deviceNames[event.deviceId] ?? "removed device"}` : ""}
                  {detail ? <span className="text-fg-dim">{` · ${detail}`}</span> : null}
                </span>
              </span>
            );
          })}
        </div>
      ) : (
        <p className="zf-sub px-3 py-2">No events match. New ones appear here as they are recorded.</p>
      )}
    </section>
  );
}
