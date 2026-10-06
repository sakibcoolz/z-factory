"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { configFields, formField as field } from "@/lib/process-modules/form";
import { createModule } from "@/lib/services/process-module-service";

/** Creates a module of a type in the factory and opens its editor. */
export async function createModuleAction(
  factoryId: string,
  _previous: OperationState,
  formData: FormData,
): Promise<OperationState> {
  let moduleId: string;
  try {
    const created = await createModule(getDb(), await requireActor(), {
      factoryId,
      typeId: field(formData, "typeId"),
      name: field(formData, "name"),
      location: field(formData, "location") || undefined,
      profile: field(formData, "profile") || undefined,
      config: configFields(formData),
    });
    moduleId = created.id;
  } catch (error) {
    if (!isDomainError(error)) {
      console.error(JSON.stringify({ level: "error", action: "module.create", error: String(error) }));
    }
    return toOperationState(error);
  }
  revalidatePath(routes.factory(factoryId), "layout");
  redirect(routes.module(factoryId, moduleId));
}
