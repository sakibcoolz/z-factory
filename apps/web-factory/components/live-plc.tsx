"use client";

import Link from "next/link";
import type { PlcLiveView } from "@/lib/live/types";
import { CommandControl } from "./command-control";
import { PlcStatePill, QualityPill } from "./connectivity";
import { agoText, LiveBadge, shownValue, useLiveView, useNow } from "./live";
import { AlarmTable } from "./live-alarms";

export type TagMeta = {
  role: string;
  range: string;
  /** A command or setpoint tag the cloud may write (TASK-905). */
  writable: boolean;
  boolean: boolean;
  min: number | null;
  max: number | null;
};

/** A PLC's tags with live values, quality and age, and its active alarms. */
export function LivePlc({
  initial,
  meta,
  canAcknowledge,
  canCommand,
}: {
  initial: PlcLiveView;
  meta: Record<string, TagMeta>;
  canAcknowledge: boolean;
  canCommand: boolean;
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
                {canCommand ? <th>Command</th> : null}
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
                  {canCommand ? (
                    <td>
                      {meta[tag.tag]?.writable ? (
                        <CommandControl
                          plcId={plc.plcId}
                          tag={tag.tag}
                          name={tag.name}
                          boolean={meta[tag.tag]!.boolean}
                          min={meta[tag.tag]!.min}
                          max={meta[tag.tag]!.max}
                          unit={tag.unit}
                        />
                      ) : null}
                    </td>
                  ) : null}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card" aria-label="Commands">
        <h2>Commands</h2>
        <p className="muted">
          A command or setpoint is written to the PLC&apos;s command tag; the PLC program and its interlocks decide what
          the machine does. The agent checks every command against its own allow-list again.
        </p>
        <CommandTable commands={view.commands} now={now} />
      </section>
      <section className="card" aria-label="Alarms">
        <h2>Alarms</h2>
        <AlarmTable alarms={view.alarms} now={now} canAcknowledge={canAcknowledge} />
      </section>
    </>
  );
}

const STATUS_TONE: Record<string, string> = {
  APPLIED: "ok",
  ACCEPTED: "",
  PUBLISHED: "",
  REQUESTED: "",
  REJECTED: "danger",
  FAILED: "danger",
  TIMED_OUT: "warn",
};

/** Recent commands: who asked what, how far it got, what the agent read back, what telemetry showed. */
export function CommandTable({ commands, now }: { commands: PlcLiveView["commands"]; now: number }) {
  if (commands.length === 0) return <p className="muted">No command sent yet.</p>;
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Sent</th>
            <th>By</th>
            <th>Tag</th>
            <th>Value</th>
            <th>Status</th>
            <th>Read back</th>
            <th>Telemetry</th>
          </tr>
        </thead>
        <tbody>
          {commands.map((command) => (
            <tr key={command.id} data-command={command.status}>
              <td title={command.requestedAt}>{agoText(command.requestedAt, now)}</td>
              <td>{command.requestedBy}</td>
              <td className="mono">{command.tagName}</td>
              <td className="mono">{shownValue(command.value, null)}</td>
              <td>
                <span className={`pill ${STATUS_TONE[command.status] ?? ""}`}>
                  {command.status.toLowerCase().replace("_", " ")}
                </span>
                {command.lateAnswer ? <span className="muted"> (late answer)</span> : null}
                {command.reason ? <span className="muted"> {command.reason}</span> : null}
                {command.duplicateAcks > 0 ? (
                  <span className="muted"> · redelivered {command.duplicateAcks}×, written once</span>
                ) : null}
              </td>
              <td className="mono">
                {command.observed === null || command.observed === undefined ? "—" : shownValue(command.observed, null)}
              </td>
              <td>
                {command.confirmedAt
                  ? `confirmed ${agoText(command.confirmedAt, now)}`
                  : command.status === "APPLIED"
                    ? "not yet seen"
                    : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
