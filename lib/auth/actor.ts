import "server-only";
import { DomainError } from "@/lib/domain/errors";
import { getServerEnv } from "@/lib/env";

/** Who is performing a request. Every factory operation is scoped to `ownerId`. */
export type Actor = {
  ownerId: string;
};

const DEVELOPMENT_OWNER_ID = "local-owner";

/**
 * ADR-0007: the MVP runs in single-owner mode. The owner comes from `LOCAL_OWNER_ID`;
 * outside production it falls back to a fixed development owner. A production process
 * without an explicit owner refuses every request instead of running unowned.
 */
export function resolveLocalOwner(options: { nodeEnv: string | undefined; localOwnerId: string | undefined }): Actor {
  if (options.localOwnerId) return { ownerId: options.localOwnerId };
  if (options.nodeEnv !== "production") return { ownerId: DEVELOPMENT_OWNER_ID };
  throw new DomainError("UNAUTHORIZED", "No owner is configured for this deployment.", { rule: "owner-required" });
}

/**
 * The authorization boundary: every server action, route handler and page that touches
 * factory data calls this first. Replacing single-owner mode with a real identity
 * provider means changing only this function (and needs a new ADR).
 */
export async function requireActor(): Promise<Actor> {
  return resolveLocalOwner({ nodeEnv: process.env.NODE_ENV, localOwnerId: getServerEnv().LOCAL_OWNER_ID });
}
