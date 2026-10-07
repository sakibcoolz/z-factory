import type { Metadata } from "next";
import Link from "next/link";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { load } from "@/lib/page";
import { getModule } from "@/lib/services/site-service";

export const metadata: Metadata = { title: "Module" };
export const dynamic = "force-dynamic";

/** A process module and the PLCs that carry its signals. */
export default async function ModulePage({ params }: { params: Promise<{ moduleId: string }> }) {
  const { moduleId } = await params;
  const actor = await requireActor();
  const { module, organization } = await load(getModule(getDb(), actor, moduleId));
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>
          <span>/</span>
          <Link href={`/sites/${module.factory.siteId}`}>{module.factory.site.name}</Link>
          <span>/</span>
          <Link href={`/factories/${module.factoryId}`}>{module.factory.name}</Link>
          <span>/</span>
          <span>{module.name}</span>
        </div>
        <h1>{module.name}</h1>
        <span className="muted">{module.type}</span>
      </div>
      <section className="card" aria-label="PLCs">
        <h2>PLCs carrying its signals</h2>
        {module.plcs.length === 0 ? (
          <p className="muted">No PLC.</p>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>PLC</th>
                  <th>Agent</th>
                  <th>Tags</th>
                </tr>
              </thead>
              <tbody>
                {module.plcs.map(({ plc }) => (
                  <tr key={plc.id}>
                    <td>
                      <Link href={`/plcs/${plc.id}`}>{plc.name}</Link>
                    </td>
                    <td>
                      <Link href={`/agents/${plc.edgeAgentId}`}>{plc.agent.name}</Link>
                    </td>
                    <td>{plc._count.mappings}</td>
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
