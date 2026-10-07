import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { BrokerBanner } from "@/components/connectivity";
import { LiveSite } from "@/components/live-site";
import { can } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { brokerStatus, connectivityLimits } from "@/lib/mqtt/boundary";
import { toJson } from "@/lib/live/json";
import type { SiteLiveView } from "@/lib/live/types";
import { load } from "@/lib/page";
import { liveView } from "@/lib/services/live-service";
import { getSite } from "@/lib/services/site-service";
import { createAgentAction } from "../../actions";

export const metadata: Metadata = { title: "Site" };
export const dynamic = "force-dynamic";

export default async function SitePage({ params }: { params: Promise<{ siteId: string }> }) {
  const { siteId } = await params;
  const actor = await requireActor();
  const limits = connectivityLimits();
  const { site, organization, role } = await load(getSite(getDb(), actor, siteId, limits));
  const live = toJson(await liveView(getDb(), actor, { kind: "site", id: site.id }, limits)) as SiteLiveView;
  const factories = await getDb().factory.findMany({
    where: { siteId: site.id },
    orderBy: { name: "asc" },
    include: { _count: { select: { plcs: true, modules: true } } },
  });
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
      <LiveSite initial={live} canAcknowledge={can(role, "command")} />
      <section className="card" aria-label="Factories">
        <h2>Factories</h2>
        {factories.length === 0 ? (
          <p className="muted">No factory yet: one appears with the first PLC registered from it.</p>
        ) : (
          <ul className="plain">
            {factories.map((factory) => (
              <li key={factory.id}>
                <Link href={`/factories/${factory.id}`}>{factory.name}</Link>{" "}
                <span className="muted">
                  · {factory._count.plcs} PLCs · {factory._count.modules} modules
                </span>
              </li>
            ))}
          </ul>
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
