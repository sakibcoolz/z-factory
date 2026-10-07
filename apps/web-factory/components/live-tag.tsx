"use client";

import type { PlcLiveView } from "@/lib/live/types";
import { PlcStatePill, QualityPill } from "./connectivity";
import { agoText, LiveBadge, shownValue, useLiveView, useNow } from "./live";
import { AlarmTable } from "./live-alarms";

/** One tag's live value, quality and age, and its alarm while one is raised. */
export function LiveTag({
  initial,
  tag,
  canAcknowledge,
}: {
  initial: PlcLiveView;
  tag: string;
  canAcknowledge: boolean;
}) {
  const { view, state } = useLiveView(`plc:${initial.plc.plcId}`, initial);
  const now = useNow();
  const current = view.plc.tags.find((entry) => entry.tag === tag);
  const alarms = view.alarms.filter((alarm) => alarm.subject === tag);
  return (
    <section className="card" aria-label="Live value">
      <div className="row">
        <h2>Now</h2>
        <LiveBadge state={state} />
      </div>
      {current ? (
        <dl className="kv">
          <dt>Value</dt>
          <dd className="mono big" data-value>
            {shownValue(current.value, current.unit)}
          </dd>
          <dt>Quality</dt>
          <dd>
            <QualityPill quality={current.quality} />
            {current.reportedQuality && current.reportedQuality !== current.quality ? (
              <span className="muted"> (the agent last sent {current.reportedQuality.toLowerCase()})</span>
            ) : null}
          </dd>
          <dt>Updated</dt>
          <dd>{agoText(current.at, now)}</dd>
          <dt>PLC connection</dt>
          <dd>
            <PlcStatePill state={view.plc.connection} />
          </dd>
        </dl>
      ) : (
        <p className="muted">This tag is no longer in the PLC&apos;s registered deployment.</p>
      )}
      {alarms.length > 0 ? <AlarmTable alarms={alarms} now={now} canAcknowledge={canAcknowledge} /> : null}
    </section>
  );
}
