"use client";

import { useActionState, useEffect, useMemo, useState } from "react";
import { StatePill, tagQualityTone } from "@/components/ui/state-pill";
import { applyTagMessage, type LiveTagReading, mergeReadings, qualityAt, tagKey } from "@/lib/domain/live";
import { TAG_QUALITIES, type TagDataType, type TagQuality, type TagRole } from "@/lib/domain/tag";
import { EMPTY_OPERATION_STATE, type OperationState } from "@/lib/plc/operation-state";
import { STREAM_STATUS_LABEL, type StreamStatus, useFactoryStream } from "./use-factory-stream";

export type LiveTagTableRow = {
  plcId: string;
  plcName: string;
  name: string;
  role: TagRole;
  dataType: TagDataType;
  unit: string | null;
  logicalAddress: string | null;
  deviceName: string | null;
  reading: LiveTagReading;
  /** Server action writing this tag; null for a tag only PLC logic and the devices produce. */
  write: WriteAction | null;
};

export type WriteAction = (state: OperationState, formData: FormData) => Promise<OperationState>;

type LiveTagTableProps = {
  rows: readonly LiveTagTableRow[];
  streamUrl: string;
  staleAfterMs: number;
  /** Shown when several PLCs are listed. */
  showPlc: boolean;
};

const QUALITY_SHORT: Record<TagQuality, string> = { GOOD: "GOOD", STALE: "STALE", BAD: "BAD", DISCONNECTED: "DISC" };
const STATUS_TONE: Record<StreamStatus, "run" | "deg" | "flt" | "neutral"> = {
  connecting: "neutral",
  live: "run",
  reconnecting: "deg",
  paused: "neutral",
  offline: "flt",
};

function formatValue(value: number | boolean | null, unit: string | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "ON" : "OFF";
  const text = Number.isInteger(value) ? String(value) : value.toFixed(2);
  return unit ? `${text} ${unit}` : text;
}

/** `now`, `4 s`, `3 min`, `2 h`: how long ago the value was last confirmed. */
function formatAge(readAt: string | null, nowMs: number): string {
  if (readAt === null) return "never";
  const seconds = Math.max(0, Math.round((nowMs - Date.parse(readAt)) / 1000));
  if (seconds < 2) return "now";
  if (seconds < 90) return `${seconds} s`;
  if (seconds < 5400) return `${Math.round(seconds / 60)} min`;
  return `${Math.round(seconds / 3600)} h`;
}

function WriteCell({
  row,
  value,
  action,
}: {
  row: LiveTagTableRow;
  value: number | boolean | null;
  action: WriteAction;
}) {
  const [state, formAction, pending] = useActionState(action, EMPTY_OPERATION_STATE);
  const result = pending ? null : state.message ? (
    <span className="zf-error whitespace-normal">{state.message}</span>
  ) : state.notice ? (
    <span className="zf-notice whitespace-normal">{state.notice}</span>
  ) : null;

  if (row.dataType === "BOOL") {
    return (
      <form action={formAction} className="flex flex-col gap-1" aria-label={`Write ${row.name}`}>
        <span className="flex gap-1.5">
          {[true, false].map((target) => (
            <button
              key={String(target)}
              type="submit"
              name="value"
              value={String(target)}
              className="zf-btn"
              data-size="sm"
              data-variant={value === target ? "ghost" : "default"}
              disabled={pending}
            >
              {target ? "Set ON" : "Set OFF"}
            </button>
          ))}
        </span>
        <span role="status">{result}</span>
      </form>
    );
  }
  return (
    <form action={formAction} className="flex flex-col gap-1" aria-label={`Write ${row.name}`}>
      <span className="flex gap-1.5">
        <input
          name="value"
          className="zf-input mono w-24"
          inputMode="decimal"
          aria-label={`New value for ${row.name}${row.unit ? ` in ${row.unit}` : ""}`}
          placeholder={row.unit ?? "value"}
          required
        />
        <button type="submit" className="zf-btn" data-size="sm" data-variant="primary" disabled={pending}>
          {pending ? "Writing…" : "Write"}
        </button>
      </span>
      <span role="status">{result}</span>
    </form>
  );
}

/**
 * 2l — Live Tags of a stored factory: value, quality and age of every tag, updated from
 * the live stream. Command and setpoint tags can be written; every other tag is what
 * PLC logic and the devices report, and is read-only.
 */
export function LiveTagTable({ rows, streamUrl, staleAfterMs, showPlc }: LiveTagTableProps) {
  const [readings, setReadings] = useState(() => new Map(rows.map((row) => [tagKey(row.reading), row.reading])));
  const [nowMs, setNowMs] = useState(() => Date.now());

  const status = useFactoryStream(streamUrl, (message) => {
    if (message.kind === "tags") setReadings((known) => applyTagMessage(known, message));
    // On every (re)connect the server sends everything it knows; older values give way.
    else if (message.kind === "snapshot") setReadings((known) => mergeReadings(known, message.snapshot.tags));
  });

  useEffect(() => {
    const timer = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const shown = useMemo(
    () =>
      rows.map((row) => {
        const reading = readings.get(tagKey(row.reading)) ?? row.reading;
        // Without a stream nothing confirms a value any more.
        const quality =
          status === "live" || status === "connecting"
            ? qualityAt(reading, nowMs, staleAfterMs)
            : qualityAt(reading, Infinity, staleAfterMs);
        return { row, reading, quality };
      }),
    [rows, readings, nowMs, staleAfterMs, status],
  );
  const count = (quality: TagQuality) => shown.filter((item) => item.quality === quality).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5" role="status" aria-label="Live stream">
        <StatePill tone={STATUS_TONE[status]}>{`stream · ${STREAM_STATUS_LABEL[status]}`}</StatePill>
        {TAG_QUALITIES.map((quality) => (
          <StatePill key={quality} tone={count(quality) > 0 ? tagQualityTone(quality) : "off"}>
            {`${QUALITY_SHORT[quality]} ${count(quality)}`}
          </StatePill>
        ))}
        <span className="zf-k ml-auto">{`${rows.length} tags · stale after ${Math.round(staleAfterMs / 1000)} s`}</span>
      </div>
      {rows.length > 0 ? (
        <table className="zf-tbl">
          <thead>
            <tr>
              <th>Tag</th>
              {showPlc ? <th>PLC</th> : null}
              <th>Role</th>
              <th>Type · address</th>
              <th>Value</th>
              <th>Quality</th>
              <th>Updated</th>
              <th>Write</th>
            </tr>
          </thead>
          <tbody>
            {shown.map(({ row, reading, quality }) => {
              const good = quality === "GOOD";
              return (
                <tr key={tagKey(row.reading)} data-muted={quality === "DISCONNECTED"}>
                  <td>
                    <span className="mono syn-var">{row.name}</span>
                    {row.deviceName ? <div className="mono text-fg-dim">{row.deviceName}</div> : null}
                  </td>
                  {showPlc ? <td className="mono">{row.plcName}</td> : null}
                  <td>{row.role.toLowerCase().replace("_", " ")}</td>
                  <td className="mono">
                    <span className="syn-type">{row.dataType}</span>
                    <span className="text-fg-dim">{` · ${row.logicalAddress ?? "—"}`}</span>
                  </td>
                  <td className={good ? "mono font-bold text-fg-strong" : "mono font-bold text-warn-fg"}>
                    {formatValue(reading.value, row.unit)}
                  </td>
                  <td>
                    <StatePill tone={tagQualityTone(quality)}>{QUALITY_SHORT[quality]}</StatePill>
                  </td>
                  <td className={good ? "mono" : "mono text-warn-fg"}>{formatAge(reading.readAt, nowMs)}</td>
                  <td>
                    {row.write ? (
                      <WriteCell row={row} value={reading.value} action={row.write} />
                    ) : (
                      <span className="zf-k">read-only</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      ) : (
        <p className="zf-sub">No tags yet. Tags are created when devices are connected to a PLC.</p>
      )}
    </div>
  );
}
