import type { Metadata } from "next";
import Link from "next/link";
import { ago, PlcStatePill, QualityPill } from "@/components/connectivity";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { getLatest, getPlcEvents } from "@/lib/services/telemetry-service";
import { getPlc } from "@/lib/services/site-service";

export const metadata: Metadata = { title: "PLC" };
export const dynamic = "force-dynamic";

/** Engineering limits, without float noise (3276.7000000000003 → 3276.7). */
const limit = (value: number) => String(Number(value.toPrecision(10)));

export default async function PlcPage({ params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  const actor = await requireActor();
  const limits = connectivityLimits();
  const { plc, organization, connection, edge } = await load(getPlc(getDb(), actor, plcId, limits));
  const now = new Date();
  const [latest, recent] = await Promise.all([
    getLatest(getDb(), actor, plc.id, limits, now),
    getPlcEvents(getDb(), actor, plc.id, { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), limit: "20" }),
  ]);
  const values = new Map(latest.tags.map((tag) => [tag.tag, tag]));
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
          <span>{plc.name}</span>
        </div>
        <h1>{plc.name}</h1>
        <dl className="kv">
          <dt>Factory</dt>
          <dd>{plc.factory.name}</dd>
          <dt>PLC id</dt>
          <dd className="mono">{plc.externalPlcId}</dd>
          <dt>Configuration</dt>
          <dd className="mono">
            v{plc.configVersion} · {plc.checksum.slice(0, 19)}…
          </dd>
          <dt>Reached by the agent at</dt>
          <dd className="mono">
            Modbus TCP {connection.host}:{connection.port} unit {connection.unitId} · every {connection.pollIntervalMs}{" "}
            ms
          </dd>
          <dt>Connection</dt>
          <dd>
            <PlcStatePill state={edge.state} />
            {edge.note ? <span className="muted"> {edge.note}</span> : null}
            {plc.edgeLastPollAt ? <span className="muted"> · last poll {ago(plc.edgeLastPollAt)}</span> : null}
          </dd>
          <dt>Modules</dt>
          <dd>{plc.modules.map((entry) => `${entry.module.name} (${entry.module.type})`).join(", ") || "—"}</dd>
        </dl>
      </div>
      <section className="card">
        <h2>Tags</h2>
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
                <th>Type</th>
                <th>Range</th>
                <th>Value</th>
                <th>Quality</th>
                <th>Updated</th>
              </tr>
            </thead>
            <tbody>
              {plc.mappings.map((mapping) => (
                <tr key={mapping.id}>
                  <td className="mono">{mapping.name}</td>
                  <td>
                    <span className={mapping.access === "WRITE" ? "pill warn" : "pill"}>
                      {mapping.access === "WRITE" ? "writable" : "read"}
                    </span>
                  </td>
                  <td>{mapping.role.toLowerCase().replace("_", " ")}</td>
                  <td className="mono">
                    {mapping.dataType}
                    {mapping.unit ? ` ${mapping.unit}` : ""}
                  </td>
                  <td className="mono">
                    {mapping.dataType === "BOOL"
                      ? "on / off"
                      : mapping.min !== null && mapping.max !== null
                        ? `${limit(mapping.min)} … ${limit(mapping.max)}`
                        : "—"}
                  </td>
                  <td className="mono">{shown(values.get(mapping.externalId)?.value ?? null, mapping.unit)}</td>
                  <td>
                    <QualityPill quality={values.get(mapping.externalId)?.quality ?? "DISCONNECTED"} />
                  </td>
                  <td>{ago(values.get(mapping.externalId)?.at ?? null, now)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Events</h2>
        {recent.events.length === 0 ? (
          <p className="muted">No state or quality change in the last 7 days.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>What</th>
                  <th>Change</th>
                </tr>
              </thead>
              <tbody>
                {recent.events.map((event) => (
                  <tr key={`${event.kind}${event.subject}${event.at.toISOString()}`}>
                    <td className="mono">{event.at.toISOString().replace("T", " ").slice(0, 19)}</td>
                    <td>
                      {event.kind === "PLC_STATE"
                        ? "PLC connection"
                        : (plc.mappings.find((mapping) => mapping.externalId === event.subject)?.name ?? event.subject)}
                    </td>
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
    </>
  );
}

/** A value as shown: on/off for booleans, numbers without float noise, with the unit. */
function shown(value: number | boolean | null, unit: string | null): string {
  if (value === null) return "—";
  if (typeof value === "boolean") return value ? "on" : "off";
  return `${Number(value.toPrecision(10))}${unit ? ` ${unit}` : ""}`;
}
