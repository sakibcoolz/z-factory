"use server";

import { revalidatePath } from "next/cache";
import { requireActor } from "@/lib/auth/actor";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import { routes } from "@/lib/navigation/routes";
import { type OperationState, toOperationState } from "@/lib/plc/operation-state";
import {
  addGateway,
  connectGateway,
  mapAllGatewayTags,
  mapGatewayTag,
  removeGatewayConnection,
  setGatewayConnectionEnabled,
  unmapGatewayTag,
} from "@/lib/services/gateway-service";
import { getGatewayDeps } from "@/lib/services/runtime-deps";

/**
 * Configuration of the factory's external gateways. Nothing here writes a PLC tag: these
 * actions decide what an edge device is given, and the endpoint enforces it.
 */

function logUnexpected(action: string, error: unknown) {
  if (!isDomainError(error)) console.error(JSON.stringify({ level: "error", action, error: String(error) }));
}

const field = (formData: FormData, name: string) => {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
};

async function run(factoryId: string, name: string, action: () => Promise<string>): Promise<OperationState> {
  try {
    return { notice: await action() };
  } catch (error) {
    logUnexpected(`gateway.${name}`, error);
    return toOperationState(error);
  } finally {
    revalidatePath(routes.factory(factoryId), "layout");
  }
}

/** Adds a gateway device to the factory. */
export async function addGatewayAction(factoryId: string, _previous: OperationState, _formData: FormData) {
  return run(factoryId, "add", async () => {
    const gateway = await addGateway(getGatewayDeps(), await requireActor(), factoryId);
    return `${gateway.name} was added. Connect it to a PLC below.`;
  });
}

/** Connects a gateway to a PLC on an address and port of this host. */
export async function connectGatewayAction(
  factoryId: string,
  gatewayDeviceId: string,
  _previous: OperationState,
  formData: FormData,
) {
  return run(factoryId, "connect", async () => {
    await connectGateway(getGatewayDeps(), await requireActor(), gatewayDeviceId, {
      plcId: field(formData, "plcId"),
      host: field(formData, "host"),
      port: field(formData, "port"),
      unitId: field(formData, "unitId") || undefined,
      pollIntervalMs: field(formData, "pollIntervalMs") || undefined,
    });
    return "The endpoint is open. Map the tags the gateway may read and write.";
  });
}

/** Enables, disables or removes a connection, maps every tag, or takes one mapping away. */
export async function gatewayConnectionAction(
  factoryId: string,
  connectionId: string,
  _previous: OperationState,
  formData: FormData,
) {
  const operation = field(formData, "operation");
  return run(factoryId, operation.split(":")[0] ?? "connection", async () => {
    const deps = getGatewayDeps();
    const actor = await requireActor();
    if (operation === "enable" || operation === "disable") {
      await setGatewayConnectionEnabled(deps, actor, connectionId, operation === "enable");
      return operation === "enable" ? "The endpoint is open." : "The endpoint is closed. Its mappings are kept.";
    }
    if (operation === "remove") {
      await removeGatewayConnection(deps, actor, connectionId);
      return "The connection and its mappings were removed.";
    }
    if (operation === "map-all") {
      const count = await mapAllGatewayTags(deps, actor, connectionId);
      return count === 0 ? "Every tag is mapped already." : `${count} tag${count === 1 ? " was" : "s were"} mapped.`;
    }
    if (operation.startsWith("unmap:")) {
      await unmapGatewayTag(deps, actor, connectionId, operation.slice("unmap:".length));
      return "The gateway no longer has this tag.";
    }
    throw new DomainError("VALIDATION", "Unknown gateway operation.");
  });
}

/** Gives a gateway one tag of the PLC, to read or to read and write. */
export async function mapGatewayTagAction(
  factoryId: string,
  connectionId: string,
  _previous: OperationState,
  formData: FormData,
) {
  return run(factoryId, "map", async () => {
    await mapGatewayTag(getGatewayDeps(), await requireActor(), connectionId, {
      tagId: field(formData, "tagId"),
      access: field(formData, "access") || undefined,
      externalName: field(formData, "externalName") || undefined,
    });
    return "The tag was mapped.";
  });
}
