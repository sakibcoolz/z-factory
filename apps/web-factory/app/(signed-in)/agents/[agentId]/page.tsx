import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ago, BrokerBanner } from "@/components/connectivity";
import { CredentialsForm } from "@/components/credentials-form";
import { LiveAgent } from "@/components/live-agent";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { toJson } from "@/lib/live/json";
import type { AgentLiveView } from "@/lib/live/types";
import { load } from "@/lib/page";
import { liveView } from "@/lib/services/live-service";
import { getAgent } from "@/lib/services/site-service";
import { issueCredentialsAction, registerDeploymentAction, revokeCredentialsAction } from "../../actions";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const actor = await requireActor();
  const limits = connectivityLimits();
  const { agent, organization, role, topicRoot, plcs, credentials, events } = await load(
    getAgent(getDb(), actor, agentId, limits),
  );
  const live = toJson(await liveView(getDb(), actor, { kind: "agent", id: agent.id }, limits)) as AgentLiveView;
  const admin = can(role, "manageSites");
  const registered = Object.fromEntries(
    plcs.map((plc) => [
      plc.id,
      { factory: plc.factory, configVersion: plc.configVersion, mappings: plc.mappings, writable: plc.writable },
    ]),
  );
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
        </dl>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <LiveAgent initial={live} registered={registered} canAcknowledge={can(role, "command")} />
      <section className="card">
        <h2>Connection history</h2>
        {events.length === 0 ? (
          <p className="muted">No status change seen yet.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>When (UTC)</th>
                  <th>Reported</th>
                </tr>
              </thead>
              <tbody>
                {events.map((event) => (
                  <tr key={event.id}>
                    <td className="mono">{event.at.toISOString().replace("T", " ").slice(0, 19)}</td>
                    <td>{event.status.toLowerCase()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
      {admin ? (
        <section className="card">
          <h2>Broker credentials</h2>
          <p className="muted">
            {credentials.state === "NONE"
              ? "This agent has no broker credentials yet. Issue them to let it connect; it may then publish and subscribe only under its own topics."
              : credentials.state === "ISSUED"
                ? `Issued ${ago(credentials.at)} as ${credentials.username}. Issuing again replaces the password and disconnects the agent until it uses the new one.`
                : `Revoked ${ago(credentials.at)}. The agent cannot connect until new credentials are issued.`}
          </p>
          <div className="actions">
            <CredentialsForm
              action={issueCredentialsAction.bind(null, agent.id)}
              submit={credentials.state === "ISSUED" ? "Issue a new password" : "Issue credentials"}
              confirm={
                credentials.state === "ISSUED"
                  ? "The agent's current password stops working and it is disconnected. Continue?"
                  : undefined
              }
            />
            {credentials.state === "ISSUED" ? (
              <ActionForm
                action={revokeCredentialsAction.bind(null, agent.id)}
                submit="Revoke"
                pending="Revoking…"
                variant="danger"
                confirm="The agent is disconnected and cannot connect again. Continue?"
              />
            ) : null}
          </div>
        </section>
      ) : null}
      {admin ? (
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
