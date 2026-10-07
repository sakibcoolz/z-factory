import type { Metadata } from "next";
import Link from "next/link";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { load } from "@/lib/page";
import { getFactory } from "@/lib/services/site-service";

export const metadata: Metadata = { title: "Factory" };
export const dynamic = "force-dynamic";

/** A Z-Factory factory as its PLCs' deployments name it: its modules and PLCs. */
export default async function FactoryPage({ params }: { params: Promise<{ factoryId: string }> }) {
  const { factoryId } = await params;
  const actor = await requireActor();
  const { factory, organization } = await load(getFactory(getDb(), actor, factoryId));
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <Link href={`/sites/${factory.siteId}`}>{factory.site.name}</Link>
          <span>/</span>
          <span>{factory.name}</span>
        </div>
        <h1>{factory.name}</h1>
        <span className="mono muted">factory id {factory.externalFactoryId}</span>
      </div>
      <section className="card" aria-label="Modules">
        <h2>Modules</h2>
        {factory.modules.length === 0 ? (
          <p className="muted">No module.</p>
        ) : (
          <ul className="plain">
            {factory.modules.map((module) => (
              <li key={module.id}>
                <Link href={`/modules/${module.id}`}>{module.name}</Link>{" "}
                <span className="muted">
                  · {module.type} · {module._count.plcs} PLC{module._count.plcs === 1 ? "" : "s"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
      <section className="card" aria-label="PLCs">
        <h2>PLCs</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>PLC</th>
                <th>Agent</th>
                <th>Version</th>
                <th>Tags</th>
              </tr>
            </thead>
            <tbody>
              {factory.plcs.map((plc) => (
                <tr key={plc.id}>
                  <td>
                    <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
                  </td>
                  <td>
                    <Link href={`/agents/${plc.edgeAgentId}`}>{plc.agent.name}</Link>
                  </td>
                  <td className="mono">v{plc.configVersion}</td>
                  <td>{plc._count.mappings}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
