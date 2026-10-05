import "server-only";
import { notFound } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { getFactory } from "@/lib/services/factory-service";
import { getPlcConfiguration } from "@/lib/services/plc-config-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a stored PLC with its configuration. Unknown or malformed ids, a PLC of another
 * factory and a PLC of another owner all end in the same not-found screen.
 */
export async function loadPlc(factoryId: string, plcId: string) {
  if (!UUID.test(factoryId) || !UUID.test(plcId)) notFound();
  const actor = await requireActor();
  const db = getDb();
  try {
    const [factory, view] = await Promise.all([
      getFactory(db, actor, factoryId),
      getPlcConfiguration(db, actor, plcId),
    ]);
    if (view.plc.factoryId !== factory.id) notFound();
    return { actor, db, factory, view };
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "INCOMPATIBLE")) notFound();
    throw error;
  }
}
