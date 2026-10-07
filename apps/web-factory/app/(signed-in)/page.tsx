import Link from "next/link";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/session";
import { ROLE_LABELS } from "@/lib/auth/roles";
import { getDb } from "@/lib/db/client";
import { listMyOrganizations } from "@/lib/services/user-service";

export default async function HomePage() {
  const actor = await requireActor();
  const organizations = await listMyOrganizations(getDb(), actor);
  if (organizations.length === 1) redirect(`/orgs/${organizations[0]!.id}`);
  return (
    <div className="card">
      <h1>Organizations</h1>
      {organizations.length === 0 ? (
        <p className="muted">You are not a member of any organization yet. Ask an admin to add you.</p>
      ) : (
        <ul>
          {organizations.map((organization) => (
            <li key={organization.id}>
              <Link href={`/orgs/${organization.id}`}>{organization.name}</Link>{" "}
              <span className="muted">· {ROLE_LABELS[organization.role]}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
