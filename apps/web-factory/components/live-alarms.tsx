"use client";

import Link from "next/link";
import { acknowledgeAlarmAction } from "@/app/(signed-in)/actions";
import type { AlarmJson } from "@/lib/live/types";
import { ActionForm } from "./action-form";
import { agoText, LiveBadge, useLiveView, useNow } from "./live";

const SEVERITY_TONE = { HIGH: "danger", MEDIUM: "warn", LOW: "" } as const;
const SOURCE_LABEL: Record<string, string> = {
  PLC_TAG: "PLC alarm",
  PLC_CONNECTION: "PLC connection",
  AGENT_CONNECTION: "Agent",
};

/** Alarms as a table: severity, what, where, since, state; acknowledge where allowed. */
export function AlarmTable({
  alarms,
  now,
  canAcknowledge,
  showSite = false,
  empty = "No active or unacknowledged alarm.",
}: {
  alarms: AlarmJson[];
  now: number;
  canAcknowledge: boolean;
  showSite?: boolean;
  empty?: string;
}) {
  if (alarms.length === 0) return <p className="muted">{empty}</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Severity</th>
            <th>Alarm</th>
            {showSite ? <th>Site</th> : null}
            <th>Raised</th>
            <th>State</th>
            <th>Acknowledged</th>
          </tr>
        </thead>
        <tbody>
          {alarms.map((alarm) => (
            <tr key={alarm.id} data-alarm={alarm.source}>
              <td>
                <span className={`pill ${SEVERITY_TONE[alarm.severity]}`}>{alarm.severity.toLowerCase()}</span>
              </td>
              <td>
                <span className="muted">{SOURCE_LABEL[alarm.source] ?? alarm.source}: </span>
                {alarm.plcId ? (
                  <Link
                    href={
                      alarm.subject
                        ? `/plcs/${alarm.plcId}/tags/${encodeURIComponent(alarm.subject)}`
                        : `/plcs/${alarm.plcId}`
                    }
                  >
                    {alarm.message}
                  </Link>
                ) : alarm.agentId ? (
                  <Link href={`/agents/${alarm.agentId}`}>{alarm.message}</Link>
                ) : (
                  alarm.message
                )}
              </td>
              {showSite ? (
                <td>
                  <Link href={`/sites/${alarm.siteId}`}>{alarm.siteName}</Link>
                </td>
              ) : null}
              <td title={alarm.raisedAt}>{agoText(alarm.raisedAt, now)}</td>
              <td>
                {alarm.active ? (
                  <span className="pill danger">active</span>
                ) : (
                  <span className="pill" title={alarm.clearedAt ?? undefined}>
                    cleared {agoText(alarm.clearedAt, now)}
                  </span>
                )}
              </td>
              <td>
                {alarm.acknowledgedAt ? (
                  <span className="muted" title={alarm.acknowledgedAt}>
                    {alarm.acknowledgedBy}, {agoText(alarm.acknowledgedAt, now)}
                  </span>
                ) : canAcknowledge ? (
                  <ActionForm
                    action={acknowledgeAlarmAction.bind(null, alarm.id)}
                    submit="Acknowledge"
                    pending="…"
                    variant="default"
                  />
                ) : (
                  <span className="muted">not yet</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** An organization's active and unacknowledged alarms, live. */
export function LiveOrgAlarms({
  initial,
  canAcknowledge,
}: {
  initial: { scope: { id: string }; alarms: AlarmJson[] };
  canAcknowledge: boolean;
}) {
  const { view, state } = useLiveView(`org:${initial.scope.id}`, initial);
  const now = useNow();
  const active = view.alarms.filter((alarm) => alarm.active).length;
  return (
    <section className="card" aria-label="Active alarms">
      <div className="row">
        <h2>Active and unacknowledged</h2>
        <LiveBadge state={state} />
        <span className="muted" data-active-count={active}>
          {active} active
        </span>
      </div>
      <AlarmTable alarms={view.alarms} now={now} canAcknowledge={canAcknowledge} showSite />
    </section>
  );
}
