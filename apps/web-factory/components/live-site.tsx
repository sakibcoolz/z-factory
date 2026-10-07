"use client";

import Link from "next/link";
import type { SiteLiveView } from "@/lib/live/types";
import { ConnectivityPill } from "./connectivity";
import { agoText, LiveBadge, useLiveView, useNow } from "./live";
import { AlarmTable } from "./live-alarms";

/** A site's agents with live connectivity, and the site's alarms. */
export function LiveSite({ initial, canAcknowledge }: { initial: SiteLiveView; canAcknowledge: boolean }) {
  const { view, state } = useLiveView(`site:${initial.scope.id}`, initial);
  const now = useNow();
  return (
    <>
      <section className="card" aria-label="Thin Client Agents">
        <div className="row">
          <h2>Thin Client Agents</h2>
          <LiveBadge state={state} />
        </div>
        {view.agents.length === 0 ? (
          <p className="muted">No agent registered yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Agent</th>
                  <th>Agent id</th>
                  <th>Status</th>
                  <th>Last seen</th>
                  <th>PLCs</th>
                </tr>
              </thead>
              <tbody>
                {view.agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <Link href={`/agents/${agent.id}`}>{agent.name}</Link>
                    </td>
                    <td className="mono">{agent.agentKey}</td>
                    <td title={agent.connectivity.reasons.join("; ")}>
                      <ConnectivityPill state={agent.connectivity.state} />
                    </td>
                    <td>{agoText(agent.lastSeenAt, now)}</td>
                    <td>
                      {agent.plcs.length === 0
                        ? "—"
                        : agent.plcs.map((plc, index) => (
                            <span key={plc.id}>
                              {index > 0 ? ", " : ""}
                              <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
                            </span>
                          ))}
                    </td>
                  </tr>
                ))}
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
