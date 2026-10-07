import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ago, BrokerBanner, ConnectivityPill } from "@/components/connectivity";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { getSite } from "@/lib/services/site-service";
import { createAgentAction } from "../../actions";

export const metadata: Metadata = { title: "Site" };
export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const actor = await requireActor();
  const { site, organization, role, agents } = await load(getSite(getDb(), actor, siteId, connectivityLimits()));
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <span>{site.name}</span>
        </div>
        <h1>{site.name}</h1>
        <span className="mono muted">site id {site.siteKey}</span>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <section className="card">
        <h2>Thin Client Agents</h2>
        {agents.length === 0 ? (
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
                {agents.map((agent) => (
                  <tr key={agent.id}>
                    <td>
                      <Link href={`/agents/${agent.id}`}>{agent.name}</Link>
                    </td>
                    <td className="mono">{agent.agentKey}</td>
                    <td title={agent.connectivity.reasons.join("; ")}>
                      <ConnectivityPill state={agent.connectivity.state} />
                    </td>
                    <td>{ago(agent.lastSeenAt)}</td>
                    <td>{agent.plcs.map((plc) => plc.name).join(", ") || "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {can(role, "manageSites") ? (
        <section className="card">
          <h2>Register an agent</h2>
          <p className="muted">Use the agent id the agent runs with (-agent-id, ZFACTORY_AGENT_ID).</p>
          <ActionForm action={createAgentAction.bind(null, site.id)} submit="Register agent" pending="Registering…">
            <label>
              Name
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Agent id
              <input name="agentKey" required pattern="[A-Za-z0-9_-]{1,64}" className="mono" />
            </label>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
