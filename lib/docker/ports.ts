import "server-only";
import type Docker from "dockerode";
import { DomainError } from "@/lib/domain/errors";
import { dockerCall } from "./errors";
import { isManaged } from "./labels";
import type { RuntimePolicy } from "./policy";

export type PortBinding = { containerPort: number; hostPort: number; bindAddress: string };
export type PublishedPort = { hostPort: number; bindAddress: string };

const WILDCARDS = new Set(["0.0.0.0", "::", ""]);

/** Two bindings collide on the same host port unless they use different specific addresses. */
function collides(a: PublishedPort, b: PublishedPort): boolean {
  if (a.hostPort !== b.hostPort) return false;
  return a.bindAddress === b.bindAddress || WILDCARDS.has(a.bindAddress) || WILDCARDS.has(b.bindAddress);
}

/**
 * Validates host port publishing before Docker is asked: allowed bind address, allowed
 * range, no duplicate inside the request and no collision with a port already published.
 */
export function assertPortBindings(
  requested: readonly PortBinding[],
  taken: readonly PublishedPort[],
  policy: Pick<RuntimePolicy, "portRange" | "bindAddresses">,
): void {
  requested.forEach((binding, index) => {
    if (!policy.bindAddresses.includes(binding.bindAddress)) {
      throw new DomainError("VALIDATION", "This bind address is not allowed for runtime ports.", {
        rule: "bind-address-allowed",
        bindAddress: binding.bindAddress,
      });
    }
    if (binding.hostPort < policy.portRange.min || binding.hostPort > policy.portRange.max) {
      throw new DomainError(
        "VALIDATION",
        `Host port ${binding.hostPort} is outside the allowed range ${policy.portRange.min}-${policy.portRange.max}.`,
        { rule: "host-port-range", hostPort: binding.hostPort },
      );
    }
    if (requested.slice(0, index).some((earlier) => collides(earlier, binding))) {
      throw new DomainError("CONFLICT", `Host port ${binding.hostPort} is requested more than once.`, {
        rule: "host-port-duplicate",
        hostPort: binding.hostPort,
      });
    }
    if (taken.some((published) => collides(published, binding))) {
      throw new DomainError("CONFLICT", `Host port ${binding.hostPort} is already published.`, {
        rule: "host-port-taken",
        hostPort: binding.hostPort,
      });
    }
  });
}

/** Picks the lowest free host ports in the allowed range for the default bind address. */
export function allocateHostPorts(
  count: number,
  taken: readonly PublishedPort[],
  policy: Pick<RuntimePolicy, "portRange" | "bindAddresses">,
): number[] {
  const bindAddress = policy.bindAddresses[0] ?? "127.0.0.1";
  const allocated: number[] = [];
  for (let port = policy.portRange.min; port <= policy.portRange.max && allocated.length < count; port += 1) {
    const candidate = { hostPort: port, bindAddress };
    if (!taken.some((published) => collides(published, candidate))) allocated.push(port);
  }
  if (allocated.length < count) {
    throw new DomainError("CONFLICT", "No free host port is left in the runtime port range.", {
      rule: "host-ports-exhausted",
    });
  }
  return allocated;
}

/**
 * Host ports claimed on this Docker host: published by any running container (managed by
 * Z-Factory or not), plus the bindings of Z-Factory containers that are not running yet.
 */
export async function listPublishedPorts(docker: Docker): Promise<PublishedPort[]> {
  const containers = await dockerCall("list containers", () => docker.listContainers({ all: true }));
  const published: PublishedPort[] = [];
  for (const container of containers) {
    if (container.State === "running") {
      for (const port of container.Ports) {
        if (port.PublicPort !== undefined) published.push({ hostPort: port.PublicPort, bindAddress: port.IP ?? "" });
      }
    } else if (isManaged(container.Labels)) {
      const details = await dockerCall("inspect container", () => docker.getContainer(container.Id).inspect());
      for (const bindings of Object.values(details.HostConfig.PortBindings ?? {})) {
        for (const binding of (bindings ?? []) as Array<{ HostIp?: string; HostPort?: string }>) {
          if (binding.HostPort)
            published.push({ hostPort: Number(binding.HostPort), bindAddress: binding.HostIp ?? "" });
        }
      }
    }
  }
  return published;
}
