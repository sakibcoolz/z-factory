import type { Metadata } from "next";
import Link from "next/link";
import { BrokerBanner } from "@/components/connectivity";
import { LivePlc, type TagMeta } from "@/components/live-plc";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { toJson } from "@/lib/live/json";
import type { PlcLiveView } from "@/lib/live/types";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { liveView } from "@/lib/services/live-service";
import { getPlcEvents } from "@/lib/services/telemetry-service";
import { getPlc } from "@/lib/services/site-service";

export const metadata: Metadata = { title: "PLC" };
export const dynamic = "force-dynamic";

/** Engineering limits, without float noise (3276.7000000000003 → 3276.7). */
const limit = (value: number) => String(Number(value.toPrecision(10)));

export default async function PlcPage({ params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  const actor = await requireActor();
  const limits = connectivityLimits();
  const { plc, organization, role, connection } = await load(getPlc(getDb(), actor, plcId, limits));
  const now = new Date();
  const [live, recent] = await Promise.all([
    liveView(getDb(), actor, { kind: "plc", id: plc.id }, limits, now),
    getPlcEvents(getDb(), actor, plc.id, { from: new Date(now.getTime() - 7 * 86_400_000).toISOString(), limit: "20" }),
  ]);
  const meta: Record<string, TagMeta> = Object.fromEntries(
    plc.mappings.map((mapping) => [
      mapping.externalId,
      {
        role: mapping.role,
        writable: mapping.access === "WRITE" && (mapping.role === "COMMAND" || mapping.role === "SETPOINT"),
        boolean: mapping.dataType === "BOOL",
        min: mapping.min,
        max: mapping.max,
        range:
          mapping.dataType === "BOOL"
            ? "on / off"
            : mapping.min !== null && mapping.max !== null
              ? `${limit(mapping.min)} … ${limit(mapping.max)}`
              : "—",
      },
    ]),
  );
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
          <dd>
            <Link href={`/factories/${plc.factory.id}`}>{plc.factory.name}</Link>
          </dd>
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
          <dt>Modules</dt>
          <dd>
            {plc.modules.length === 0
              ? "—"
              : plc.modules.map((entry, index) => (
                  <span key={entry.module.id}>
                    {index > 0 ? ", " : ""}
                    <Link href={`/modules/${entry.module.id}`}>{entry.module.name}</Link>{" "}
                    <span className="muted">({entry.module.type})</span>
                  </span>
                ))}
          </dd>
        </dl>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <LivePlc
        initial={toJson(live) as PlcLiveView}
        meta={meta}
        canAcknowledge={can(role, "command")}
        canCommand={can(role, "command")}
      />
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
