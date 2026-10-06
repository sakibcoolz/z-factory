"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type ActionState, readForm, toActionState } from "@/lib/plc/form-state";
import { createPlc, deletePlc, installModule, removeModule } from "@/lib/services/plc-config-service";

/**
 * PLC configuration mutations. Each action passes the authorization boundary first and
 * validates in the service. They change configuration only; none starts a container.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

export async function createPlcAction(
  factoryId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = readForm(formData, ["deviceModelId", "name", "role"]);
  let plcId: string;
  try {
    const actor = await requireActor();
    plcId = (await createPlc(getDb(), actor, { factoryId, ...values, role: values.role || undefined })).id;
  } catch (error) {
    logUnexpected("plc.create", error);
    return toActionState(error, values);
  }
  revalidatePath(routes.factory(factoryId));
  redirect(routes.plcHardware(factoryId, plcId));
}

export async function deletePlcAction(factoryId: string, plcId: string, _previous: ActionState): Promise<ActionState> {
  try {
    await deletePlc(getDb(), await requireActor(), plcId);
  } catch (error) {
    logUnexpected("plc.delete", error);
    return toActionState(error, {});
  }
  revalidatePath(routes.factory(factoryId));
  redirect(routes.factory(factoryId));
}

export async function installModuleAction(
  factoryId: string,
  plcId: string,
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const values = readForm(formData, ["moduleModelId", "slotIndex"]);
  try {
    await installModule(getDb(), await requireActor(), plcId, {
      moduleModelId: values.moduleModelId,
      slotIndex: Number(values.slotIndex),
    });
  } catch (error) {
    logUnexpected("plc.module.install", error);
    return toActionState(error, values);
  }
  revalidatePath(routes.plc(factoryId, plcId), "layout");
  redirect(routes.plcHardware(factoryId, plcId));
}

export async function removeModuleAction(
  factoryId: string,
  plcId: string,
  moduleId: string,
  _previous: ActionState,
): Promise<ActionState> {
  try {
    await removeModule(getDb(), await requireActor(), plcId, moduleId);
  } catch (error) {
    logUnexpected("plc.module.remove", error);
    return toActionState(error, {});
  }
  revalidatePath(routes.plc(factoryId, plcId), "layout");
  redirect(routes.plcHardware(factoryId, plcId));
}
