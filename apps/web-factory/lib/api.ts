import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { currentActor } from "@/lib/auth/session";
import { isDomainError } from "@/lib/domain/errors";
import { log } from "@/lib/log";

/**
 * The JSON API's one way of answering (TASK-903): the session decides who asks, a domain
 * refusal becomes 400 or 404 (never 403: what the actor may not see does not exist for
 * them), and nothing is cached.
 */
export async function answer(
  request: Request,
  work: (actor: Actor, query: Record<string, string>) => Promise<unknown>,
): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const actor = await currentActor();
  if (!actor) return Response.json({ error: "Sign in first." }, { status: 401, headers });
  const query = Object.fromEntries(new URL(request.url).searchParams);
  try {
    return Response.json(await work(actor, query), { headers });
  } catch (error) {
    if (isDomainError(error, "VALIDATION")) {
      return Response.json({ error: error.message, ...error.details }, { status: 400, headers });
    }
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "FORBIDDEN")) {
      return Response.json({ error: "Not found." }, { status: 404, headers });
    }
    log("error", "api failed", {
      path: new URL(request.url).pathname,
      error: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "Something went wrong." }, { status: 500, headers });
  }
}
