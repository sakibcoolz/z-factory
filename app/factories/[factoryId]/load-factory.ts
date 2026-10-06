import "server-only";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { getDockerEngineStatus } from "@/lib/docker/status";
import { isDomainError } from "@/lib/domain/errors";
import { getFactory, listFactories } from "@/lib/services/factory-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a factory for the view/edit screens. Unknown ids, malformed ids and factories
 * of another owner all end in the same not-found screen.
 */
export async function loadFactory(factoryId: string) {
  if (!UUID.test(factoryId)) notFound();

  const actor = await requireActor();
  const db = getDb();
  try {
    const [factory, factories, docker] = await Promise.all([
      getFactory(db, actor, factoryId),
      listFactories(db, actor),
      getDockerEngineStatus(getDocker()),
    ]);
    return { factory, factories, docker, actor };
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
}
