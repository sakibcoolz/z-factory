import "server-only";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { actorForSession } from "@/lib/services/user-service";
import type { Actor } from "./actor";

/** The signed-in actor, or null: no session, a disabled user, or a revoked session. */
export async function currentActor(): Promise<Actor | null> {
  const session = await auth();
  return actorForSession(getDb(), session?.uid, session?.sv);
}

/** Every page and action that touches data starts here. */
export async function requireActor(): Promise<Actor> {
  const actor = await currentActor();
  if (!actor) redirect("/login");
  return actor;
}
