"use client";

import { useEffect, useState } from "react";

/**
 * Live updates in the browser (TASK-904): a view of one scope from /api/v1/live, replaced
 * whenever the server sends a newer one. EventSource reconnects by itself; the state says
 * whether the page is live. Until the first event the server-rendered view is shown.
 */
export type LiveState = "connecting" | "live" | "reconnecting";

export function useLiveView<T>(scope: string, initial: T): { view: T; state: LiveState } {
  const [view, setView] = useState(initial);
  const [state, setState] = useState<LiveState>("connecting");
  useEffect(() => {
    const source = new EventSource(`/api/v1/live?scope=${encodeURIComponent(scope)}`);
    source.addEventListener("view", (event) => {
      setView(JSON.parse((event as MessageEvent<string>).data) as T);
      setState("live");
    });
    source.addEventListener("open", () => setState("live"));
    source.addEventListener("error", () => setState("reconnecting"));
    return () => source.close();
  }, [scope]);
  return { view, state };
}

/** The current time, every `ms`, so "12 s ago" keeps counting. */
export function useNow(ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

export function agoText(at: string | null, now: number): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now - new Date(at).getTime()) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return `${at.slice(0, 16).replace("T", " ")} UTC`;
}

/** Whether the page is live, as a small pill. */
export function LiveBadge({ state }: { state: LiveState }) {
  const text = state === "live" ? "live" : state === "connecting" ? "connecting…" : "reconnecting…";
  return (
    <span className={`pill ${state === "live" ? "ok" : "warn"}`} role="status" aria-live="polite">
      {text}
    </span>
  );
}

/** A value as shown: on/off for booleans, numbers without float noise, with the unit. */
export function shownValue(value: number | boolean | null, unit: string | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  return `${Number(value.toPrecision(10))}${unit ? ` ${unit}` : ""}`;
}
