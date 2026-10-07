import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { load } from "@/lib/page";
import { getAgent } from "@/lib/services/site-service";
import { registerDeploymentAction } from "../../actions";

export const metadata: Metadata = { title: "Agent" };

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const actor = await requireActor();
  const { agent, organization, role, topicRoot, plcs } = await load(getAgent(getDb(), actor, agentId));
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <Link href={`/sites/${agent.siteId}`}>{agent.site.name}</Link>
          <span>/</span>
          <span>{agent.name}</span>
        </div>
        <h1>{agent.name}</h1>
        <dl className="kv">
          <dt>Agent id</dt>
          <dd className="mono">{agent.agentKey}</dd>
          <dt>MQTT topics</dt>
          <dd className="mono">{topicRoot}/…</dd>
          <dt>Status</dt>
          <dd>
            {agent.status === "UNKNOWN"
              ? "not heard from yet (connectivity arrives with MQTT)"
              : agent.status.toLowerCase()}
          </dd>
        </dl>
      </div>
      <section className="card">
        <h2>PLCs</h2>
        {plcs.length === 0 ? (
          <p className="muted">No PLC registered yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PLC</th>
                  <th>Factory</th>
                  <th>Version</th>
                  <th>Tags</th>
                  <th>Writable</th>
                </tr>
              </thead>
              <tbody>
                {plcs.map((plc) => (
                  <tr key={plc.id}>
                    <td>
                      <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
                    </td>
                    <td>{plc.factory}</td>
                    <td className="mono">v{plc.configVersion}</td>
                    <td>{plc.mappings}</td>
                    <td>{plc.writable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {can(role, "manageSites") ? (
        <section className="card">
          <h2>Register a PLC</h2>
          <p className="muted">
            Upload the PLC&apos;s edge deployment file, the same file this agent runs (Z-Factory → PLC → Export → Edge
            deployment). Web Factory checks its checksum and never connects to the PLC.
          </p>
          <ActionForm action={registerDeploymentAction.bind(null, agent.id)} submit="Register" pending="Checking…">
            <label>
              Deployment file
              <input name="deployment" type="file" accept="application/json,.json" required />
            </label>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
