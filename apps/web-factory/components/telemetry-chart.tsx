"use client";

import { useEffect, useMemo, useState } from "react";

/**
 * A tag's history as an SVG chart (TASK-904; built in, no chart library). The range is
 * fetched in at most ~300 buckets from /api/v1/plcs/{id}/history. Numbers show the bucket
 * average with a min/max band; booleans a step line of the last value. Buckets whose worst
 * quality was not GOOD are shaded, and a gap in the data breaks the line: nothing missing
 * is drawn as if it were there. The short ranges refresh every 5 s.
 */

type Bucket = {
  at: string;
  count: number;
  min: number | null;
  max: number | null;
  avg: number | null;
  last: number | boolean | null;
  quality: string;
};

export const RANGES = [
  { key: "15m", label: "15 min", ms: 15 * 60_000, live: true },
  { key: "1h", label: "1 h", ms: 3_600_000, live: true },
  { key: "6h", label: "6 h", ms: 6 * 3_600_000, live: false },
  { key: "24h", label: "24 h", ms: 86_400_000, live: false },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000, live: false },
  { key: "30d", label: "30 days", ms: 30 * 86_400_000, live: false },
] as const;

const WIDTH = 800;
const HEIGHT = 240;
const PAD = { left: 56, right: 12, top: 12, bottom: 28 };

function format(value: number): string {
  return String(Number(value.toPrecision(6)));
}

function time(ms: number, spanMs: number): string {
  const iso = new Date(ms).toISOString();
  return spanMs > 86_400_000 ? `${iso.slice(5, 10)} ${iso.slice(11, 16)}` : iso.slice(11, 19);
}

export function TelemetryChart({
  plcId,
  tag,
  unit,
  boolean,
}: {
  plcId: string;
  tag: string;
  unit: string | null;
  boolean: boolean;
}) {
  const [range, setRange] = useState<(typeof RANGES)[number]>(RANGES[1]);
  const [data, setData] = useState<{ buckets: Bucket[]; from: number; to: number; bucketMs: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const to = Date.now();
      const from = to - range.ms;
      const bucketS = Math.max(1, Math.ceil(range.ms / 1000 / 300));
      const query = new URLSearchParams({
        tag,
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        bucket: String(bucketS),
        limit: "1000",
      });
      try {
        const response = await fetch(`/api/v1/plcs/${plcId}/history?${query}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`the history could not be loaded (${response.status})`);
        const body = (await response.json()) as { buckets: Bucket[] };
        if (!cancelled) {
          setData({ buckets: body.buckets, from, to, bucketMs: bucketS * 1000 });
          setError(null);
        }
      } catch (failure) {
        if (!cancelled) setError(failure instanceof Error ? failure.message : "the history could not be loaded");
      }
    };
    void load();
    const timer = range.live ? setInterval(() => void load(), 5_000) : undefined;
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [plcId, tag, range]);

  const chart = useMemo(() => {
    if (!data || data.buckets.length === 0) return null;
    const value = (bucket: Bucket): number | null => {
      if (boolean) return bucket.last === null ? null : bucket.last === true || bucket.last === 1 ? 1 : 0;
      return bucket.avg;
    };
    const values = data.buckets
      .flatMap((bucket) => (boolean ? [value(bucket)] : [bucket.min, bucket.max, bucket.avg]))
      .filter((entry): entry is number => entry !== null);
    if (values.length === 0) return null;
    let low = boolean ? 0 : Math.min(...values);
    let high = boolean ? 1 : Math.max(...values);
    if (low === high) {
      low -= 1;
      high += 1;
    }
    const x = (ms: number) => PAD.left + ((ms - data.from) / (data.to - data.from)) * (WIDTH - PAD.left - PAD.right);
    const y = (entry: number) => PAD.top + (1 - (entry - low) / (high - low)) * (HEIGHT - PAD.top - PAD.bottom);
    // A gap of more than two buckets breaks the line.
    const segments: Array<Array<[number, number]>> = [];
    const band: Array<{ x0: number; x1: number; y0: number; y1: number }> = [];
    const shaded: Array<{ x0: number; x1: number; quality: string }> = [];
    let previous: number | null = null;
    for (const bucket of data.buckets) {
      const at = new Date(bucket.at).getTime();
      const entry = value(bucket);
      const x0 = x(at);
      const x1 = x(Math.min(at + data.bucketMs, data.to));
      if (bucket.quality !== "GOOD") shaded.push({ x0, x1, quality: bucket.quality });
      if (entry === null) {
        previous = null;
        continue;
      }
      if (previous === null || at - previous > 2 * data.bucketMs) segments.push([]);
      const segment = segments[segments.length - 1]!;
      if (boolean && segment.length > 0) segment.push([x0, segment[segment.length - 1]![1]]);
      segment.push([x0, y(entry)]);
      if (boolean) segment.push([x1, y(entry)]);
      if (!boolean && bucket.min !== null && bucket.max !== null)
        band.push({ x0, x1, y0: y(bucket.max), y1: y(bucket.min) });
      previous = at;
    }
    return { low, high, segments, band, shaded };
  }, [data, boolean]);

  return (
    <div className="chart">
      <div className="row" role="group" aria-label="Time range">
        {RANGES.map((option) => (
          <button
            key={option.key}
            type="button"
            className={option.key === range.key ? "primary" : undefined}
            aria-pressed={option.key === range.key}
            onClick={() => setRange(option)}
          >
            {option.label}
          </button>
        ))}
        {range.live ? <span className="muted">refreshes every 5 s</span> : null}
      </div>
      {error ? (
        <p className="error" role="alert">
          {error}
        </p>
      ) : !data ? (
        <p className="muted">Loading…</p>
      ) : !chart ? (
        <p className="muted">No value in this range.</p>
      ) : (
        <svg
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          role="img"
          aria-label={`History of the last ${range.label}`}
          className="chart-svg"
        >
          {chart.shaded.map((area, index) => (
            <rect
              key={`q${index}`}
              x={area.x0}
              y={PAD.top}
              width={Math.max(1, area.x1 - area.x0)}
              height={HEIGHT - PAD.top - PAD.bottom}
              className={`chart-quality q-${area.quality.toLowerCase()}`}
            >
              <title>{area.quality.toLowerCase()}</title>
            </rect>
          ))}
          {chart.band.map((area, index) => (
            <rect
              key={`b${index}`}
              x={area.x0}
              y={area.y0}
              width={Math.max(1, area.x1 - area.x0)}
              height={Math.max(1, area.y1 - area.y0)}
              className="chart-band"
            />
          ))}
          {chart.segments.map((segment, index) => (
            <polyline
              key={`s${index}`}
              points={segment.map(([px, py]) => `${px.toFixed(1)},${py.toFixed(1)}`).join(" ")}
              className="chart-line"
            />
          ))}
          <line x1={PAD.left} x2={PAD.left} y1={PAD.top} y2={HEIGHT - PAD.bottom} className="chart-axis" />
          <line
            x1={PAD.left}
            x2={WIDTH - PAD.right}
            y1={HEIGHT - PAD.bottom}
            y2={HEIGHT - PAD.bottom}
            className="chart-axis"
          />
          <text x={PAD.left - 6} y={PAD.top + 10} textAnchor="end" className="chart-label">
            {boolean ? "on" : format(chart.high)}
          </text>
          <text x={PAD.left - 6} y={HEIGHT - PAD.bottom} textAnchor="end" className="chart-label">
            {boolean ? "off" : format(chart.low)}
          </text>
          <text x={PAD.left} y={HEIGHT - 8} className="chart-label">
            {time(data!.from, range.ms)}
          </text>
          <text x={WIDTH - PAD.right} y={HEIGHT - 8} textAnchor="end" className="chart-label">
            {time(data!.to, range.ms)} UTC{unit ? ` · ${unit}` : ""}
          </text>
        </svg>
      )}
    </div>
  );
}
