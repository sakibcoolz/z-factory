import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ActionForm } from "@/components/action-form";
import { currentActor } from "@/lib/auth/session";
import { signInAction } from "./actions";

export const metadata: Metadata = { title: "Sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  if (await currentActor()) redirect("/");
  return (
    <main className="center">
      <div className="card" style={{ width: "100%", maxWidth: 380 }}>
        <h1>Web Factory</h1>
        <p className="muted">Sign in to monitor your sites.</p>
        <ActionForm action={signInAction} submit="Sign in" pending="Signing in…" className="stack">
          <label>
            E-mail
            <input name="email" type="email" autoComplete="username" required />
          </label>
          <label>
            Password
            <input name="password" type="password" autoComplete="current-password" required />
          </label>
        </ActionForm>
      </div>
    </main>
  );
}
