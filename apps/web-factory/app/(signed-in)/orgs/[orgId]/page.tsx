import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { can, ROLE_LABELS } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { load } from "@/lib/page";
import { listSites } from "@/lib/services/site-service";
import { createSiteAction } from "../../actions";

export const metadata: Metadata = { title: "Sites" };

export default async function OrganizationPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const actor = await requireActor();
  const { organization, role, sites } = await load(listSites(getDb(), actor, orgId));
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
          </section>
        ))}
      </div>
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
