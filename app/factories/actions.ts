"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { createFactory, deleteFactory, updateFactory } from "@/lib/services/factory-service";
import {
  type DeleteFactoryState,
  type FactoryFormState,
  readFactoryForm,
  toErrorMessage,
  toFormState,
} from "@/lib/factories/form-state";

/**
 * Factory mutations. Each action passes the authorization boundary (`requireActor`)
 * first and validates in the service; none of them starts Docker or touches runtime state.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

export async function createFactoryAction(_previous: FactoryFormState, formData: FormData): Promise<FactoryFormState> {
  const values = readFactoryForm(formData);
  let factoryId: string;
  try {
    const actor = await requireActor();
    factoryId = (await createFactory(getDb(), actor, values)).id;
  } catch (error) {
    logUnexpected("factory.create", error);
    return toFormState(error, values);
  }
  revalidatePath(routes.factories());
  redirect(routes.factory(factoryId));
}

export async function updateFactoryAction(
  factoryId: string,
  _previous: FactoryFormState,
  formData: FormData,
): Promise<FactoryFormState> {
  const values = readFactoryForm(formData);
  try {
    const actor = await requireActor();
    await updateFactory(getDb(), actor, factoryId, values);
  } catch (error) {
    logUnexpected("factory.update", error);
    return toFormState(error, values);
  }
  revalidatePath(routes.factories());
  redirect(routes.factory(factoryId));
}

export async function deleteFactoryAction(
  factoryId: string,
  _previous: DeleteFactoryState,
): Promise<DeleteFactoryState> {
  try {
    const actor = await requireActor();
    await deleteFactory(getDb(), actor, factoryId);
  } catch (error) {
    logUnexpected("factory.delete", error);
    return { message: toErrorMessage(error) };
  }
  revalidatePath(routes.factories());
  redirect(routes.factories());
}
