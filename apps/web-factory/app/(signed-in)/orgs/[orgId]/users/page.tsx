import type { Metadata } from "next";
import Link from "next/link";
import { ActionForm } from "@/components/action-form";
import { ROLE_LABELS, ROLES } from "@/lib/auth/roles";
import { requireActor } from "@/lib/auth/session";
import { getDb } from "@/lib/db/client";
import { load } from "@/lib/page";
import { listAudit } from "@/lib/services/site-service";
import { listMembers } from "@/lib/services/user-service";
import { addMemberAction, memberAction } from "../../../actions";

export const metadata: Metadata = { title: "Users" };

const when = (date: Date | null) => (date ? date.toISOString().replace("T", " ").slice(0, 16) + " UTC" : "—");

export default async function UsersPage({ params }: { params: Promise<{ orgId: string }> }) {
  const { orgId } = await params;
  const actor = await requireActor();
  const db = getDb();
  const members = await load(listMembers(db, actor, orgId));
  const events = await load(listAudit(db, actor, orgId));
  return (
    <>
      <div>
        <div className="crumbs">
          <Link href={`/orgs/${orgId}`}>Sites</Link>
          <span>/</span>
          <span>Users</span>
        </div>
        <h1>Users</h1>
      </div>
      <section className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>User</th>
                <th>Role</th>
                <th>Status</th>
                <th>Last sign-in</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr key={member.userId}>
                  <td>
                    {member.name}
                    <div className="mono muted">{member.email}</div>
                  </td>
                  <td>
                    <ActionForm
                      action={memberAction.bind(null, orgId, member.userId)}
                      submit="Change"
                      variant="default"
                    >
                      <input type="hidden" name="operation" value="role" />
                      <select name="role" defaultValue={member.role} aria-label={`Role of ${member.email}`}>
                        {ROLES.map((role) => (
                          <option key={role} value={role}>
                            {ROLE_LABELS[role]}
                          </option>
                        ))}
                      </select>
                    </ActionForm>
                  </td>
                  <td>
                    <span className={member.status === "ACTIVE" ? "pill ok" : "pill danger"}>
                      {member.status.toLowerCase()}
                    </span>
                    {member.locked ? <span className="pill warn"> locked</span> : null}
                  </td>
                  <td className="mono">{when(member.lastLoginAt)}</td>
                  <td>
                    {member.userId === actor.userId ? (
                      <span className="muted">you</span>
                    ) : (
                      <ActionForm
                        action={memberAction.bind(null, orgId, member.userId)}
                        submit={member.status === "ACTIVE" ? "Disable" : "Enable"}
                        variant={member.status === "ACTIVE" ? "danger" : "default"}
                        confirm={
                          member.status === "ACTIVE" ? `Disable ${member.email}? Their sessions end now.` : undefined
                        }
                      >
                        <input
                          type="hidden"
                          name="operation"
                          value={member.status === "ACTIVE" ? "disable" : "enable"}
                        />
                      </ActionForm>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
      <section className="card">
        <h2>Add a user</h2>
        <p className="muted">
          A new user signs in with this password and should change it under Account. An existing user is only added to
          this organization.
        </p>
        <ActionForm action={addMemberAction.bind(null, orgId)} submit="Add user" pending="Adding…">
          <label>
            Name
            <input name="name" required maxLength={120} />
          </label>
          <label>
            E-mail
            <input name="email" type="email" required />
          </label>
          <label>
            Role
            <select name="role" defaultValue="VIEWER">
              {ROLES.map((role) => (
                <option key={role} value={role}>
                  {ROLE_LABELS[role]}
                </option>
              ))}
            </select>
          </label>
          <label>
            First password
            <input name="password" type="password" minLength={12} autoComplete="new-password" />
          </label>
        </ActionForm>
      </section>
      <section className="card">
        <h2>Audit</h2>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>When</th>
                <th>Who</th>
                <th>What</th>
                <th>Details</th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id}>
                  <td className="mono">{when(event.at)}</td>
                  <td>{event.actor?.email ?? "—"}</td>
                  <td className="mono">{event.action}</td>
                  <td className="mono muted">{JSON.stringify(event.detailJson)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}
