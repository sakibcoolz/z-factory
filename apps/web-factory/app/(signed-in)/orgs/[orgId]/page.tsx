import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ago, BrokerBanner } from "@/components/connectivity";
import { can, ROLE_LABELS } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { type Connectivity, CONNECTIVITY_LABELS, projectAgent } from "@/lib/domain/connectivity";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { load } from "@/lib/page";
import { listAlarms } from "@/lib/services/alarm-service";
import { listSites } from "@/lib/services/site-service";
import { createSiteAction } from "../../actions";

export const metadata: Metadata = { title: "Sites" };
export const dynamic = "force-dynamic";

const ORDER: Connectivity[] = ["ONLINE", "DEGRADED", "OFFLINE", "UNKNOWN"];

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const actor = await requireActor();
  const { organization, role, sites } = await load(listSites(getDb(), actor, orgId));
  const limits = connectivityLimits();
  const now = new Date();
  const broker = brokerStatus();
  const { alarms } = await listAlarms(getDb(), actor, orgId, { state: "active" });
  const activeAlarms = alarms.filter((alarm) => alarm.active);
  const unacknowledged = alarms.filter((alarm) => !alarm.acknowledgedAt).length;
  const summary = (agents: (typeof sites)[number]["agents"]) => {
    const counts = new Map<Connectivity, number>();
    for (const agent of agents) {
      const { state } = projectAgent(
        {
          status: agent.status,
          lastSeenAt: agent.lastSeenAt,
          heartbeat: agent.heartbeatJson,
          credentialRevokedAt: agent.credentialRevokedAt,
        },
        now,
        limits,
      );
      counts.set(state, (counts.get(state) ?? 0) + 1);
    }
    return ORDER.filter((state) => counts.has(state))
      .map((state) => `${counts.get(state)} ${CONNECTIVITY_LABELS[state]}`)
      .join(" · ");
  };
  return (
    <>
      <div>
        <div className="crumbs">{organization.name}</div>
        <h1>Sites</h1>
        <p className="muted">
          Your role: {ROLE_LABELS[role]}
          {can(role, "manageUsers") ? (
            <>
              {" · "}
              <Link href={`/orgs/${organization.id}/users`}>Users and audit</Link>
            </>
          ) : null}
        </p>
      </div>
      <BrokerBanner broker={broker} />
      <section className="card" aria-label="Alarms">
        <div className="row">
          <h2>
            <Link href={`/orgs/${organization.id}/alarms`}>Alarms</Link>
          </h2>
          {activeAlarms.length === 0 ? (
            <span className="pill ok">none active</span>
          ) : (
            (["HIGH", "MEDIUM", "LOW"] as const).map((severity) => {
              const count = activeAlarms.filter((alarm) => alarm.severity === severity).length;
              return count === 0 ? null : (
                <span
                  key={severity}
                  className={`pill ${severity === "HIGH" ? "danger" : severity === "MEDIUM" ? "warn" : ""}`}
                >
                  {count} {severity.toLowerCase()}
                </span>
              );
            })
          )}
          {unacknowledged > 0 ? <span className="muted">{unacknowledged} unacknowledged</span> : null}
        </div>
      </section>
      {sites.length === 0 ? <p className="card muted">No site yet.</p> : null}
      <div className="grid">
        {sites.map((site) => (
          <section key={site.id} className="card" aria-label={site.name}>
            <h2>
              <Link href={`/sites/${site.id}`}>{site.name}</Link>
            </h2>
            <span className="mono muted">site id {site.siteKey}</span>
            <span>
              {site.agents.length} agent{site.agents.length === 1 ? "" : "s"} ·{" "}
              {site.agents.reduce((sum, agent) => sum + agent._count.plcs, 0)} PLCs · {site._count.factories} factories
            </span>
            {site.agents.length > 0 ? <span className="muted">{summary(site.agents)}</span> : null}
          </section>
        ))}
      </div>
      {can(role, "manageSites") && broker.configured ? (
        <section className="card">
          <h2>Broker connection</h2>
          <dl className="kv">
            <dt>Broker</dt>
            <dd className="mono">{broker.broker}</dd>
            <dt>State</dt>
            <dd>
              {broker.connected ? "connected" : `disconnected, retrying in ${Math.round(broker.nextRetryMs / 1000)} s`}
            </dd>
            <dt>Connected since</dt>
            <dd>{broker.connected && broker.lastConnectedAt ? ago(new Date(broker.lastConnectedAt), now) : "—"}</dd>
            <dt>Reconnects</dt>
            <dd>{Math.max(0, broker.connects - 1)}</dd>
            {broker.lastError ? (
              <>
                <dt>Last error</dt>
                <dd>{broker.lastError}</dd>
              </>
            ) : null}
          </dl>
        </section>
      ) : null}
      {can(role, "manageSites") ? (
        <section className="card">
          <h2>New site</h2>
          <p className="muted">The site id is part of every MQTT topic of its agents: zfactory/&#123;site id&#125;/…</p>
          <ActionForm action={createSiteAction.bind(null, organization.id)} submit="Create site" pending="Creating…">
            <label>
              Name
              <input name="name" required maxLength={120} />
            </label>
            <label>
              Site id
              <input name="siteKey" required pattern="[A-Za-z0-9_-]{1,64}" className="mono" />
            </label>
          </ActionForm>
        </section>
      ) : null}
    </>
  );
}
