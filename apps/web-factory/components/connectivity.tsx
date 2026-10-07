import { type Connectivity, CONNECTIVITY_LABELS } from "@/lib/domain/connectivity";

const TONE: Record<Connectivity, string> = { UNKNOWN: "", ONLINE: "ok", DEGRADED: "warn", OFFLINE: "danger" };

/** An agent's projected connectivity as a pill. */
export function ConnectivityPill({ state }: { state: Connectivity }) {
  return <span className={`pill ${TONE[state]}`}>{CONNECTIVITY_LABELS[state]}</span>;
}

const PLC_TONE: Record<string, string> = { ONLINE: "ok", DEGRADED: "warn", RECONNECTING: "warn", CONNECTING: "warn" };

export function PlcStatePill({ state }: { state: string }) {
  return (
    <span className={`pill ${PLC_TONE[state] ?? (state === "DISCONNECTED" ? "danger" : "")}`}>
      {state.toLowerCase()}
    </span>
  );
}

/** Says when the statuses on the page cannot be current: Web Factory itself is off the broker. */
export function BrokerBanner({
  broker,
}: {
  broker: { configured: false } | { configured: true; connected: boolean; nextRetryMs: number };
}) {
  if (!broker.configured) {
    return <p className="banner">MQTT is not configured for Web Factory, so agent statuses are not updated.</p>;
  }
  if (broker.connected) return null;
  return (
    <p className="banner" role="status">
      Web Factory is not connected to the MQTT broker; statuses may be out of date. Retrying in{" "}
      {Math.round(broker.nextRetryMs / 1000)} s.
    </p>
  );
}

/** "12 s ago", "5 min ago", for a time in the past. */
export function ago(at: Date | null, now = new Date()): string {
  if (!at) return "never";
  const seconds = Math.max(0, Math.round((now.getTime() - at.getTime()) / 1000));
  if (seconds < 90) return `${seconds} s ago`;
  if (seconds < 90 * 60) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 36 * 3600) return `${Math.round(seconds / 3600)} h ago`;
  return at.toISOString().slice(0, 16).replace("T", " ") + " UTC";
}
