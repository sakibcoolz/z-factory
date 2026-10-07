import "server-only";
import type Docker from "dockerode";
import { DomainError } from "@/lib/domain/errors";
import { removeRuntimeContainer } from "./containers";
import { dockerCall } from "./errors";
import { LABEL_FACTORY_ID, LABEL_MANAGED } from "./labels";
import { removeFactoryNetwork } from "./networks";

/** What was removed from Docker for a factory. */
export type RemovedFactoryResources = { containers: string[]; networks: string[] };

/** Container states in which a runtime still does something: never removed by a delete. */
const ACTIVE_STATES = new Set(["running", "restarting", "paused"]);

/**
 * Removes every Docker resource Z-Factory created for one factory (TASK-206): its runtime
 * containers, then its network. Only resources labelled both as managed by Z-Factory and
 * with this factory's id are found, so nothing of another factory, and nothing Z-Factory
 * did not create, is touched. A container that is still running stops everything: the
 * factory has to be stopped first. Repeating it after a partial failure is safe.
 */
export async function removeFactoryResources(docker: Docker, factoryId: string): Promise<RemovedFactoryResources> {
  const labels = { label: [`${LABEL_MANAGED}=true`, `${LABEL_FACTORY_ID}=${factoryId}`] };
  const containers = await dockerCall("list containers", () => docker.listContainers({ all: true, filters: labels }));
  const active = containers.filter((container) => ACTIVE_STATES.has(container.State));
  if (active.length > 0) {
    throw new DomainError("CONFLICT", "A runtime of this factory is still running. Stop the factory first.", {
      rule: "factory-runtime-active",
      containers: active.map((container) => container.Names[0]?.replace(/^\//, "") ?? container.Id),
    });
  }
  const removed: RemovedFactoryResources = { containers: [], networks: [] };
  for (const container of containers) {
    if (await removeRuntimeContainer(docker, container.Id)) {
      removed.containers.push(container.Names[0]?.replace(/^\//, "") ?? container.Id);
    }
  }
  const networks = await dockerCall("list networks", () => docker.listNetworks({ filters: labels }));
  for (const network of networks) {
    if (await removeFactoryNetwork(docker, network.Name)) removed.networks.push(network.Name);
  }
  return removed;
}
