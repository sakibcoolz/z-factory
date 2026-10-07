import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { BrokerBanner } from "@/components/connectivity";
import { LiveTag } from "@/components/live-tag";
import { TelemetryChart } from "@/components/telemetry-chart";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { toJson } from "@/lib/live/json";
import type { PlcLiveView } from "@/lib/live/types";
import { brokerStatus, connectivityLimits, getTelemetryStore } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { liveView } from "@/lib/services/live-service";
import { getPlc } from "@/lib/services/site-service";
import { getHistory, getPlcEvents } from "@/lib/services/telemetry-service";

export const metadata: Metadata = { title: "Tag" };
export const dynamic = "force-dynamic";

const shown = (value: number | boolean | null) =>
  value === null ? "—" : typeof value === "boolean" ? (value ? "on" : "off") : String(Number(value.toPrecision(10)));

/** One tag: its live value, its history as a chart, its quality changes and its last samples. */
export default async function TagPage({ params }: { params: Promise<{ plcId: string; tag: string }> }) {
  const { plcId, tag: rawTag } = await params;
  const tag = decodeURIComponent(rawTag);
  const actor = await requireActor();
  const limits = connectivityLimits();
  const { plc, organization, role } = await load(getPlc(getDb(), actor, plcId, limits));
  const mapping = plc.mappings.find((entry) => entry.externalId === tag);
  if (!mapping) notFound();
  const now = new Date();
  const [live, events, recent] = await Promise.all([
    liveView(getDb(), actor, { kind: "plc", id: plc.id }, limits, now),
    getPlcEvents(getDb(), actor, plc.id, {
      kind: "TAG_QUALITY",
      from: new Date(now.getTime() - 7 * 86_400_000).toISOString(),
      limit: "1000",
    }),
    load(getHistory(getDb(), getTelemetryStore(), actor, plc.id, { tag, limit: "10000" })),
  ]);
  const samples = "samples" in recent ? recent.samples.slice(-20).reverse() : [];
  const changes = events.events.filter((event) => event.subject === tag).slice(0, 20);
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <Link href={`/sites/${plc.agent.siteId}`}>{plc.agent.site.name}</Link>
          <span>/</span>
          <Link href={`/agents/${plc.agent.id}`}>{plc.agent.name}</Link>
          <span>/</span>
          <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
          <span>/</span>
          <span>{mapping.name}</span>
        </div>
        <h1>{mapping.name}</h1>
        <span className="muted">
          {mapping.role.toLowerCase().replace("_", " ")} · {mapping.dataType}
          {mapping.unit ? ` ${mapping.unit}` : ""} · {mapping.access === "WRITE" ? "writable" : "read only"} · tag id{" "}
          <span className="mono">{mapping.externalId}</span>
        </span>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <LiveTag initial={toJson(live) as PlcLiveView} tag={tag} canAcknowledge={can(role, "command")} />
      <section className="card" aria-label="History">
        <h2>History</h2>
        <TelemetryChart plcId={plc.id} tag={tag} unit={mapping.unit} boolean={mapping.dataType === "BOOL"} />
      </section>
      <section className="card" aria-label="Quality changes">
        <h2>Quality changes</h2>
        {changes.length === 0 ? (
          <p className="muted">No change in the last 7 days.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {changes.map((event) => (
                  <tr key={event.at.toISOString()}>
                    <td className="mono">{event.at.toISOString().replace("T", " ").slice(0, 23)}</td>
                    <td>
                      {(event.from ?? "—").toLowerCase()} → {event.to.toLowerCase()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      <section className="card" aria-label="Last samples">
        <h2>Last samples (past hour)</h2>
        {samples.length === 0 ? (
          <p className="muted">None in the past hour.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Poll time (UTC)</th>
                  <th>Value</th>
                  <th>Quality</th>
                </tr>
              </thead>
              <tbody>
                {samples.map((sample) => (
                  <tr key={sample.at.toISOString()}>
                    <td className="mono">{sample.at.toISOString().replace("T", " ").slice(0, 23)}</td>
                    <td className="mono">{shown(sample.value)}</td>
                    <td>{sample.quality.toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
