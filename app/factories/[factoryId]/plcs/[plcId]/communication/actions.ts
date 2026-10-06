"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import { formField as field } from "@/lib/process-modules/form";
import {
  addPlcLinkMapping,
  createPlcLink,
  deletePlcLink,
  removePlcLinkMapping,
  setPlcLinkEnabled,
  updatePlcLink,
  updatePlcLinkMapping,
} from "@/lib/services/plc-communication-service";

/**
 * The Communication screen's actions (TASK-704). Every one goes through the link service,
 * which holds the rules; a change applies when the client PLC's program is next deployed.
 */

const DEPLOY_NOTE = " Deploy the client PLC's program to apply it.";

const number = (formData: FormData, name: string) => {
  const value = field(formData, name);
  return value === "" ? undefined : Number(value);
};

async function run(
  factoryId: string,
  plcId: string,
  name: string,
  action: () => Promise<string>,
): Promise<OperationState> {
  try {
    return { notice: await action() };
  } catch (error) {
    if (!isDomainError(error))
      console.error(JSON.stringify({ level: "error", action: `plc-link.${name}`, error: String(error) }));
    return toOperationState(error);
  } finally {
    revalidatePath(routes.plc(factoryId, plcId), "layout");
    revalidatePath(routes.topology(factoryId));
  }
}

/** Links this PLC to another one of the factory, as its client or its server. */
export async function createLinkAction(
  factoryId: string,
  plcId: string,
  _previous: OperationState,
  formData: FormData,
) {
  return run(factoryId, plcId, "create", async () => {
    const peer = field(formData, "peerId");
    if (!peer) throw new DomainError("VALIDATION", "Choose the PLC to link to.", { field: "peerId" });
    const asClient = field(formData, "role") !== "server";
    const link = await createPlcLink(getDb(), await requireActor(), {
      factoryId,
      sourcePlcId: plcId,
      targetPlcId: peer,
      relationship: field(formData, "relationship") || "COMMUNICATES_WITH",
      client: asClient ? "SOURCE" : "TARGET",
      pollIntervalMs: number(formData, "pollIntervalMs"),
      unitId: number(formData, "unitId"),
      serverPort: number(formData, "serverPort"),
    });
    return `Linked to ${link.target.name}: ${link.client === "SOURCE" ? link.source.name : link.target.name} reads and writes ${link.serverHost}:${link.serverPort}.`;
  });
}

/** Changes, enables, disables or removes a link. */
export async function linkAction(
  factoryId: string,
  plcId: string,
  linkId: string,
  _previous: OperationState,
  formData: FormData,
) {
  const operation = field(formData, "operation");
  return run(factoryId, plcId, operation || "update", async () => {
    const db = getDb();
    const actor = await requireActor();
    if (operation === "remove") {
      await deletePlcLink(db, actor, linkId);
      return "The link was removed. Its history stays; both PLCs are unchanged.";
    }
    if (operation === "enable" || operation === "disable") {
      const link = await setPlcLinkEnabled(db, actor, linkId, operation === "enable");
      return `The link is ${link.enabled ? "enabled" : "disabled"} (version ${link.configVersion}).${DEPLOY_NOTE}`;
    }
    const link = await updatePlcLink(db, actor, linkId, {
      relationship: field(formData, "relationship") || undefined,
      pollIntervalMs: number(formData, "pollIntervalMs"),
      unitId: number(formData, "unitId"),
      serverPort: number(formData, "serverPort"),
    });
    return `Saved as version ${link.configVersion}.${DEPLOY_NOTE}`;
  });
}

/** Carries one more value over a link. */
export async function addMappingAction(
  factoryId: string,
  plcId: string,
  linkId: string,
  _previous: OperationState,
  formData: FormData,
) {
  return run(factoryId, plcId, "map", async () => {
    const localTagId = field(formData, "localTagId");
    const remoteTagId = field(formData, "remoteTagId");
    if (!localTagId || !remoteTagId) {
      throw new DomainError("VALIDATION", "Choose a tag of each PLC.", {
        field: localTagId ? "remoteTagId" : "localTagId",
      });
    }
    const mapping = await addPlcLinkMapping(getDb(), await requireActor(), linkId, {
      operation: field(formData, "operation"),
      localTagId,
      remoteTagId,
      updateIntervalMs: number(formData, "updateIntervalMs") ?? null,
    });
    return mapping.operation === "READ"
      ? `${mapping.localTag.name} now receives ${mapping.remoteTag.name}.${DEPLOY_NOTE}`
      : `${mapping.localTag.name} is now written to ${mapping.remoteTag.name}; the server's program decides what follows.${DEPLOY_NOTE}`;
  });
}

/** Enables, disables or removes one mapping. */
export async function mappingAction(
  factoryId: string,
  plcId: string,
  linkId: string,
  mappingId: string,
  _previous: OperationState,
  formData: FormData,
) {
  const operation = field(formData, "operation");
  return run(factoryId, plcId, `mapping.${operation}`, async () => {
    const db = getDb();
    const actor = await requireActor();
    if (operation === "remove") {
      await removePlcLinkMapping(db, actor, linkId, mappingId);
      return `The value is no longer carried.${DEPLOY_NOTE}`;
    }
    await updatePlcLinkMapping(db, actor, linkId, mappingId, { enabled: operation === "enable" });
    return `The value is ${operation === "enable" ? "carried again" : "paused"}.${DEPLOY_NOTE}`;
  });
}
