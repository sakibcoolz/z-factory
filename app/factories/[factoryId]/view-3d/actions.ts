"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { SCENE_ROTATION_STEP } from "@/lib/domain/scene-view";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { changeDeviceSceneTransform, type SceneTransformChange } from "@/lib/services/scene-service";

/**
 * How a device is turned and sized in the 3D view. Appearance only: nothing here
 * changes a device, a connection or a state.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** One press of Larger; Smaller is its inverse. */
const SCALE_STEP = 1.25;

const CHANGES: Record<string, SceneTransformChange> = {
  "rotate-left": { kind: "ROTATE", byDeg: SCENE_ROTATION_STEP },
  "rotate-right": { kind: "ROTATE", byDeg: -SCENE_ROTATION_STEP },
  "scale-up": { kind: "SCALE", factor: SCALE_STEP },
  "scale-down": { kind: "SCALE", factor: 1 / SCALE_STEP },
  reset: { kind: "RESET" },
};

export async function sceneTransformAction(
  factoryId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  const text = (name: string) => {
    const value = formData.get(name);
    return typeof value === "string" ? value : "";
  };
  try {
    const actor = await requireActor();
    const change = CHANGES[text("operation")];
    if (!change) throw new DomainError("VALIDATION", "Unknown scene operation.");
    const deviceId = text("deviceId");
    if (!UUID.test(deviceId)) throw new DomainError("NOT_FOUND", "The device does not exist.");
    const placed = await changeDeviceSceneTransform(getDb(), actor, deviceId, change);
    return { notice: `Turned to ${placed.rotationDeg}°, size ×${placed.scale}.` };
  } catch (error) {
    if (!isDomainError(error)) {
      console.error(JSON.stringify({ level: "error", action: "scene.transform", error: String(error) }));
    }
    return toOperationState(error);
  } finally {
    revalidatePath(routes.view3d(factoryId));
  }
}
