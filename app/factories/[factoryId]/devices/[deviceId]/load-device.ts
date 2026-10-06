import "server-only";
import { notFound, redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import type { DeviceSection } from "@/lib/domain/device-capabilities";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { getDeviceDetail } from "@/lib/services/device-detail-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads a device for one of its screens. A controller's screens are the PLC screens, so a
 * controller is sent there. A screen the model has no capability for does not exist for it.
 */
export async function loadDevice(factoryId: string, deviceId: string, section: DeviceSection) {
  if (!UUID.test(factoryId) || !UUID.test(deviceId)) notFound();
  const actor = await requireActor();
  const db = getDb();
  try {
    const device = await getDeviceDetail(db, actor, deviceId);
    if (device.factoryId !== factoryId) notFound();
    if (device.architectureType !== null) redirect(routes.plc(factoryId, deviceId));
    if (!device.sections.some((item) => item.key === section)) notFound();
    return { actor, db, device };
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) notFound();
    throw error;
  }
}
