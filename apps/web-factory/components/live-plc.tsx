"use client";

import Link from "next/link";
import type { PlcLiveView } from "@/lib/live/types";
import { PlcStatePill, QualityPill } from "./connectivity";
import { agoText, LiveBadge, shownValue, useLiveView, useNow } from "./live";
import { AlarmTable } from "./live-alarms";

export type TagMeta = { role: string; range: string };

/** A PLC's tags with live values, quality and age, and its active alarms. */
export function LivePlc({
  initial,
  meta,
  canAcknowledge,
}: {
  initial: PlcLiveView;
  meta: Record<string, TagMeta>;
  canAcknowledge: boolean;
}) {
  const { view, state } = useLiveView(`plc:${initial.plc.plcId}`, initial);
  const now = useNow();
  const plc = view.plc;
  return (
    <>
      <section className="card" aria-label="Tags">
        <div className="row">
          <h2>Tags</h2>
          <LiveBadge state={state} />
          <span className="muted">
            connection <PlcStatePill state={plc.connection} /> · polled every {plc.pollIntervalMs} ms
          </span>
        </div>
        <p className="muted">
          Only command and setpoint tags can be written from the cloud; the PLC program decides everything else.
        </p>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Tag</th>
                <th>Access</th>
                <th>Role</th>
                <th>Range</th>
                <th>Value</th>
                <th>Quality</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {plc.tags.map((tag) => (
                <tr key={tag.tag} data-tag={tag.tag}>
                  <td className="mono">
                    <Link href={`/plcs/${plc.plcId}/tags/${encodeURIComponent(tag.tag)}`}>{tag.name}</Link>
                  </td>
                  <td>
                    <span className={tag.access === "WRITE" ? "pill warn" : "pill"}>
                      {tag.access === "WRITE" ? "writable" : "read"}
                    </span>
                  </td>
                  <td>{(meta[tag.tag]?.role ?? "").toLowerCase().replace("_", " ")}</td>
                  <td className="mono">{meta[tag.tag]?.range ?? "—"}</td>
                  <td className="mono" data-value>
                    {shownValue(tag.value, tag.unit)}
                  </td>
                  <td>
                    <QualityPill quality={tag.quality} />
                  </td>
                  <td>{agoText(tag.at, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-label="Alarms">
        <h2>Alarms</h2>
        <AlarmTable alarms={view.alarms} now={now} canAcknowledge={canAcknowledge} />
      </section>
    </>
  );
}
