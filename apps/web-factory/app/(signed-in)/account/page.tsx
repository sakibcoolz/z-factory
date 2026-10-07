import type { Metadata } from "next";
import { ActionForm } from "@/components/action-form";
import { requireActor } from "@/lib/auth/session";
import { changePasswordAction } from "../actions";

export const metadata: Metadata = { title: "Account" };

export default async function AccountPage() {
  const actor = await requireActor();
  return (
    <section className="card">
      <h1>Account</h1>
      <dl className="kv">
        <dt>Name</dt>
        <dd>{actor.name}</dd>
        <dt>E-mail</dt>
        <dd className="mono">{actor.email}</dd>
      </dl>
      <h2>Change password</h2>
      <p className="muted">Every session of yours ends, this one too; sign in again with the new password.</p>
      <ActionForm action={changePasswordAction} submit="Change password" pending="Changing…" className="stack">
        <label>
          Current password
          <input name="current" type="password" autoComplete="current-password" required />
        </label>
        <label>
          New password (at least 12 characters)
          <input name="next" type="password" autoComplete="new-password" minLength={12} required />
        </label>
      </ActionForm>
    </section>
  );
}
