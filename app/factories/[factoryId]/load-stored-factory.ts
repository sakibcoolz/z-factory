import "server-only";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { getFactory } from "@/lib/services/factory-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a stored factory for a screen that needs nothing else about the host. Unknown
 * ids, malformed ids and factories of another owner all end in the same not-found screen.
 */
export async function loadStoredFactory(factoryId: string) {
  if (!UUID.test(factoryId)) notFound();
  const actor = await requireActor();
  const factory = await getFactory(getDb(), actor, factoryId).catch((error: unknown) => {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  });
  return { actor, factory };
}
