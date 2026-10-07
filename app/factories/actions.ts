"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { removeFactoryResources } from "@/lib/docker/factory-resources";
import { listHostNetworks } from "@/lib/docker/networks";
import { isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { createDemoFactory } from "@/lib/services/demo-service";
import { createFactory, deleteFactory, updateFactory } from "@/lib/services/factory-service";
import { getGatewayDeps } from "@/lib/services/runtime-deps";
import {
  type DeleteFactoryState,
  type FactoryFormState,
  readFactoryForm,
  toErrorMessage,
  toFormState,
} from "@/lib/factories/form-state";

/**
 * Factory mutations. Each action passes the authorization boundary (`requireActor`)
 * first and validates in the service. None of them starts Docker or changes runtime state;
 * deleting a stopped factory removes its leftover runtime containers and network.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

export async function createFactoryAction(_previous: FactoryFormState, formData: FormData): Promise<FactoryFormState> {
  const values = readFactoryForm(formData);
  let factoryId: string;
  try {
    const actor = await requireActor();
    factoryId = (await createFactory(getDb(), actor, values, () => listHostNetworks(getDocker()))).id;
  } catch (error) {
    logUnexpected("factory.create", error);
    return toFormState(error, values);
  }
  revalidatePath(routes.factories());
  redirect(routes.factory(factoryId));
}

/**
 * Builds the pump station demo as a stored factory and opens its runtime screen, where it
 * is started. Nothing is started here.
 */
export async function createDemoFactoryAction(_previous: OperationState, _formData: FormData): Promise<OperationState> {
  let factoryId: string;
  try {
    factoryId = (await createDemoFactory(getGatewayDeps(), await requireActor())).factoryId;
  } catch (error) {
    logUnexpected("factory.demo", error);
    return toOperationState(error);
  }
  revalidatePath(routes.factories());
  redirect(routes.runtime(factoryId));
}

export async function updateFactoryAction(
  factoryId: string,
  _previous: FactoryFormState,
  formData: FormData,
): Promise<FactoryFormState> {
  const values = readFactoryForm(formData);
  try {
    const actor = await requireActor();
    await updateFactory(getDb(), actor, factoryId, values, () => listHostNetworks(getDocker()));
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
    // Its PLC containers and network go with it (TASK-206).
    await deleteFactory(getDb(), actor, factoryId, (id) => removeFactoryResources(getDocker(), id));
  } catch (error) {
    logUnexpected("factory.delete", error);
    return { message: toErrorMessage(error) };
  }
  revalidatePath(routes.factories());
  redirect(routes.factories());
}
