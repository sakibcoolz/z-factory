"use client";

import Link from "next/link";
import type { AgentLiveView } from "@/lib/live/types";
import { ConnectivityPill, PlcStatePill } from "./connectivity";
import { agoText, LiveBadge, useLiveView, useNow } from "./live";
import { AlarmTable } from "./live-alarms";

type Heartbeat = {
  uptimeS?: number;
  workers?: number;
  byState?: Record<string, number>;
  queue?: { depth?: number; dropped?: number };
  spooled?: number;
  published?: number;
};

function uptime(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}

/** An agent's live status, heartbeat, PLC connections and alarms. */
export function LiveAgent({
  initial,
  registered,
  canAcknowledge,
}: {
  initial: AgentLiveView;
  /** Registered PLCs' static facts: factory, version, tag counts. */
  registered: Record<string, { factory: string; configVersion: number; mappings: number; writable: number }>;
  canAcknowledge: boolean;
}) {
  const { view, state } = useLiveView(`agent:${initial.agent.id}`, initial);
  const now = useNow();
  const { agent } = view;
  const heartbeat = (agent.heartbeat ?? null) as Heartbeat | null;
  return (
    <>
      <section className="card" aria-label="Status">
        <div className="row">
          <h2>Status</h2>
          <LiveBadge state={state} />
        </div>
        <dl className="kv">
          <dt>Connectivity</dt>
          <dd>
            <ConnectivityPill state={agent.connectivity.state} />
            {agent.connectivity.reasons.length > 0 ? (
              <span className="muted"> — {agent.connectivity.reasons.join("; ")}</span>
            ) : null}
          </dd>
          <dt>Last seen</dt>
          <dd>{agoText(agent.lastSeenAt, now)}</dd>
          <dt>Agent version</dt>
          <dd className="mono">{agent.agentVersion ?? "—"}</dd>
          <dt>Heartbeat</dt>
          <dd>
            {heartbeat ? (
              <>
                {agoText(agent.lastHeartbeatAt, now)} · up {uptime(heartbeat.uptimeS)} · {heartbeat.workers ?? 0} PLC
                workers
                {heartbeat.byState && Object.keys(heartbeat.byState).length > 0
                  ? ` (${Object.entries(heartbeat.byState)
                      .map(([name, count]) => `${count} ${name.toLowerCase()}`)
                      .join(", ")})`
                  : ""}{" "}
                · queue {heartbeat.queue?.depth ?? 0} waiting, {heartbeat.queue?.dropped ?? 0} dropped · spooled{" "}
                {heartbeat.spooled ?? 0} · published {heartbeat.published ?? 0}
              </>
            ) : (
              "none received yet"
            )}
          </dd>
        </dl>
      </section>
      <section className="card" aria-label="PLCs">
        <h2>PLCs</h2>
        {view.plcs.length === 0 ? (
          <p className="muted">No PLC registered yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PLC</th>
                  <th>Factory</th>
                  <th>Version</th>
                  <th>Connection</th>
                  <th>Last poll</th>
                  <th>Tags</th>
                  <th>Writable</th>
                </tr>
              </thead>
              <tbody>
                {view.plcs.map((plc) => {
                  const facts = registered[plc.id];
                  return (
                    <tr key={plc.id}>
                      <td>
                        <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
                      </td>
                      <td>{facts?.factory ?? "—"}</td>
                      <td className="mono">
                        v{facts?.configVersion}
                        {plc.edge.configVersion !== null && plc.edge.configVersion !== facts?.configVersion ? (
                          <span className="pill warn" title="The agent runs another version than the one registered">
                            agent runs v{plc.edge.configVersion}
                          </span>
                        ) : null}
                      </td>
                      <td>
                        <PlcStatePill state={plc.edge.state} />
                        {plc.edge.note ? <span className="muted"> {plc.edge.note}</span> : null}
                      </td>
                      <td>{agoText(plc.edge.lastPollAt, now)}</td>
                      <td>{facts?.mappings ?? "—"}</td>
                      <td>{facts?.writable ?? "—"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-label="Alarms">
        <h2>Alarms</h2>
        <AlarmTable alarms={view.alarms} now={now} canAcknowledge={canAcknowledge} />
      </section>
    </>
  );
}
