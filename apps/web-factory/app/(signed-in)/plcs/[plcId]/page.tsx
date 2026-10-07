import type { Metadata } from "next";
import Link from "next/link";
import { ago, PlcStatePill } from "@/components/connectivity";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { getPlc } from "@/lib/services/site-service";

export const metadata: Metadata = { title: "PLC" };
export const dynamic = "force-dynamic";

/** Engineering limits, without float noise (3276.7000000000003 → 3276.7). */
const limit = (value: number) => String(Number(value.toPrecision(10)));

export default async function PlcPage({ params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  const actor = await requireActor();
  const { plc, organization, connection, edge } = await load(getPlc(getDb(), actor, plcId, connectivityLimits()));
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
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
