import "server-only";
import type Docker from "dockerode";
import { DomainError } from "@/lib/domain/errors";
import { cidrsOverlap } from "@/lib/validation/network";
import { parseInput } from "@/lib/validation/parse";
import { dockerCall, isDockerNotFound, toDockerDomainError } from "./errors";
import { isManaged, LABEL_FACTORY_ID } from "./labels";
import type { RuntimePolicy } from "./policy";
import { buildNetworkCreateOptions, networkRequestSchema } from "./spec";

const IPV4_CIDR = /^\d{1,3}(\.\d{1,3}){3}\/\d{1,2}$/;

type ExistingNetwork = { name: string; subnets: string[]; labels: Record<string, string> };

async function listNetworks(docker: Docker): Promise<ExistingNetwork[]> {
  const networks = await dockerCall("list networks", () => docker.listNetworks());
  return networks.map((network) => ({
    name: network.Name,
    labels: network.Labels ?? {},
    subnets: (network.IPAM?.Config ?? [])
      .map((config) => config.Subnet)
      .filter((subnet): subnet is string => typeof subnet === "string" && IPV4_CIDR.test(subnet)),
  }));
}

/** A factory subnet must not overlap any network Docker already has, whoever created it. */
export function assertSubnetAvailable(subnetCidr: string, existing: readonly ExistingNetwork[]): void {
  const clash = existing.find((network) => network.subnets.some((subnet) => cidrsOverlap(subnetCidr, subnet)));
  if (clash) {
    // The other network's name stays in details for the server log, not in the message.
    throw new DomainError("CONFLICT", "This subnet overlaps a network that already exists on the Docker host.", {
      rule: "docker-subnet-overlap",
      field: "subnetCidr",
      network: clash.name,
    });
  }
}

/**
 * Creates the factory's isolated bridge network, or confirms that the existing one is
 * the same network. Idempotent: calling it again for the same factory changes nothing.
 */
export async function ensureFactoryNetwork(
  docker: Docker,
  input: unknown,
  policy: RuntimePolicy,
): Promise<{ name: string; created: boolean }> {
  const request = parseInput(networkRequestSchema, input);
  const networks = await listNetworks(docker);

  const existing = networks.find((network) => network.name === request.name);
  if (existing) {
    const sameNetwork =
      isManaged(existing.labels) &&
      existing.labels[LABEL_FACTORY_ID] === request.factoryId &&
      existing.subnets.length === 1 &&
      existing.subnets[0] === request.subnetCidr;
    if (!sameNetwork) {
      throw new DomainError("CONFLICT", "A different Docker network already uses this factory's network name.", {
        rule: "network-name-taken",
      });
    }
    return { name: request.name, created: false };
  }

  assertSubnetAvailable(request.subnetCidr, networks);
  await dockerCall("create network", () => docker.createNetwork(buildNetworkCreateOptions(request, policy)));
  return { name: request.name, created: true };
}

/**
 * Removes a factory network. Only networks Z-Factory created are ever removed, and only
 * when no container is attached. Returns false when the network does not exist.
 */
export async function removeFactoryNetwork(docker: Docker, name: string): Promise<boolean> {
  const network = docker.getNetwork(name);
  let details: Docker.NetworkInspectInfo;
  try {
    details = await network.inspect();
  } catch (error) {
    if (isDockerNotFound(error)) return false;
    throw toDockerDomainError(error, "inspect network");
  }
  if (!isManaged(details.Labels)) {
    throw new DomainError("INVARIANT", "Refusing to remove a Docker network that Z-Factory does not manage.", {
      rule: "managed-only",
    });
  }
  if (Object.keys(details.Containers ?? {}).length > 0) {
    throw new DomainError("CONFLICT", "The factory network still has containers attached.", {
      rule: "network-in-use",
    });
  }
  await dockerCall("remove network", () => network.remove());
  return true;
}
