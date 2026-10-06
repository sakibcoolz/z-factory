"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { saveDeviceParameters } from "@/lib/services/device-detail-service";

/** Stores the parameters of the form as a new version of the device's parameter set. */
export async function saveParametersAction(
  factoryId: string,
  deviceId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  // Parameter fields only: the form also carries the framework's own `$ACTION_…` entries.
  const values = Object.fromEntries(
    [...formData.entries()].filter(
      ([key, value]) => /^[a-z][A-Za-z0-9]{0,63}$/.test(key) && typeof value === "string" && value !== "",
    ),
  );
  try {
    const saved = await saveDeviceParameters(getDb(), await requireActor(), deviceId, values);
    const version = saved.versions[0]?.version ?? 1;
    return {
      notice: saved.applied
        ? `Saved as version ${version}. The simulation uses it from its next start.`
        : `Saved as version ${version}. This model is not simulated; the values are kept for the record.`,
    };
  } catch (error) {
    if (!isDomainError(error)) {
      console.error(JSON.stringify({ level: "error", action: "device.parameters", error: String(error) }));
    }
    return toOperationState(error);
  } finally {
    revalidatePath(routes.device(factoryId, deviceId), "layout");
  }
}
