import Link from "next/link";
import { requireActor } from "@/lib/auth/session";
import { signOutAction } from "./actions";

export const dynamic = "force-dynamic";

/** Everything behind sign-in. A missing, revoked or disabled session goes to /login. */
export default async function SignedInLayout({ children }: { children: React.ReactNode }) {
  const actor = await requireActor();
  return (
    <>
      <header className="topbar">
        <Link href="/" className="brand">
          Web Factory
        </Link>
        <nav>
          <span className="muted">{actor.email}</span>
          <Link href="/account">Account</Link>
          <form action={signOutAction}>
            <button type="submit">Sign out</button>
          </form>
        </nav>
      </header>
      <main className="page">{children}</main>
    </>
  );
}
