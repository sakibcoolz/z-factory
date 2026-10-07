import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ago, BrokerBanner, ConnectivityPill, PlcStatePill } from "@/components/connectivity";
import { CredentialsForm } from "@/components/credentials-form";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { getAgent } from "@/lib/services/site-service";
import { issueCredentialsAction, registerDeploymentAction, revokeCredentialsAction } from "../../actions";

export const metadata: Metadata = { title: "Agent" };
export const dynamic = "force-dynamic";

type Heartbeat = {
  uptimeS?: number;
  workers?: number;
  byState?: Record<string, number>;
  queue?: { depth?: number; dropped?: number };
  spooled?: number;
  published?: number;
};

function uptime(seconds: number | undefined): string {
  if (seconds === undefined) return "—";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)} h ${Math.floor((seconds % 3600) / 60)} min`;
  return `${Math.floor(seconds / 86_400)} d ${Math.floor((seconds % 86_400) / 3600)} h`;
}

export default async function AgentPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  const actor = await requireActor();
  const { agent, organization, role, topicRoot, plcs, connectivity, credentials, events } = await load(
    getAgent(getDb(), actor, agentId, connectivityLimits()),
  );
  const heartbeat = (agent.heartbeatJson ?? null) as Heartbeat | null;
  const admin = can(role, "manageSites");
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
            <ConnectivityPill state={connectivity.state} />
            {connectivity.reasons.length > 0 ? (
              <span className="muted"> — {connectivity.reasons.join("; ")}</span>
            ) : null}
          </dd>
          <dt>Last seen</dt>
          <dd>{ago(agent.lastSeenAt)}</dd>
          <dt>Agent version</dt>
          <dd className="mono">{agent.agentVersion ?? "—"}</dd>
        </dl>
      </div>
      <BrokerBanner broker={brokerStatus()} />
      <section className="card">
        <h2>Heartbeat</h2>
        {heartbeat ? (
          <dl className="kv">
            <dt>Received</dt>
            <dd>{ago(agent.lastHeartbeatAt)}</dd>
            <dt>Uptime</dt>
            <dd>{uptime(heartbeat.uptimeS)}</dd>
            <dt>PLC workers</dt>
            <dd>
              {heartbeat.workers ?? 0}
              {heartbeat.byState && Object.keys(heartbeat.byState).length > 0
                ? ` (${Object.entries(heartbeat.byState)
                    .map(([state, count]) => `${count} ${state.toLowerCase()}`)
                    .join(", ")})`
                : null}
            </dd>
            <dt>Telemetry queue</dt>
            <dd>
              {heartbeat.queue?.depth ?? 0} waiting, {heartbeat.queue?.dropped ?? 0} dropped
            </dd>
            <dt>Spooled offline</dt>
            <dd>{heartbeat.spooled ?? 0}</dd>
            <dt>Published</dt>
            <dd>{heartbeat.published ?? 0}</dd>
          </dl>
        ) : (
          <p className="muted">No heartbeat received yet.</p>
        )}
      </section>
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
                  <th>Connection</th>
                  <th>Last poll</th>
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
                    <td className="mono">
                      v{plc.configVersion}
                      {plc.edge.configVersion !== null && plc.edge.configVersion !== plc.configVersion ? (
                        <span className="pill warn" title="The agent runs another version than the one registered">
                          agent runs v{plc.edge.configVersion}
                        </span>
                      ) : null}
                    </td>
                    <td>
                      <PlcStatePill state={plc.edge.state} />
                      {plc.edge.note ? <span className="muted"> {plc.edge.note}</span> : null}
                    </td>
                    <td>{ago(plc.edge.lastPollAt)}</td>
                    <td>{plc.mappings}</td>
                    <td>{plc.writable}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
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
