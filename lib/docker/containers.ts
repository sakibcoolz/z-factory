import "server-only";
import type Docker from "dockerode";
import { DomainError } from "@/lib/domain/errors";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import { dockerCall, isDockerNotFound, toDockerDomainError } from "./errors";
import { ensureImage } from "./images";
import { isManaged, LABEL_DEVICE_ID, LABEL_FACTORY_ID } from "./labels";
import type { RuntimePolicy } from "./policy";
import { assertPortBindings, listPublishedPorts, type PortBinding } from "./ports";
import { buildContainerSpec } from "./spec";

/**
 * Runtime container lifecycle. Every operation on an existing container first checks
 * that Z-Factory created it, so other containers on the host are never touched.
 *
 * Container ids returned here are server-side only (`DeviceInstance.dockerContainerId`);
 * the UI and exports work with Z-Factory ids.
 */

export type RuntimeContainerStatus = {
  state: RuntimeState;
  running: boolean;
  exitCode: number | null;
  startedAt: string | null;
  imageId: string;
  factoryId: string | null;
  deviceId: string | null;
  ports: PortBinding[];
  limits: { cpus: number; memoryMb: number; pidsLimit: number | null };
};

async function inspectManaged(docker: Docker, containerId: string, action: string) {
  let details: Docker.ContainerInspectInfo;
  try {
    details = await docker.getContainer(containerId).inspect();
  } catch (error) {
    throw toDockerDomainError(error, action);
  }
  if (!isManaged(details.Config.Labels)) {
    throw new DomainError("INVARIANT", "Refusing to operate on a container that Z-Factory does not manage.", {
      rule: "managed-only",
    });
  }
  return details;
}

async function assertManagedNetwork(docker: Docker, networkName: string): Promise<void> {
  let details: Docker.NetworkInspectInfo;
  try {
    details = await docker.getNetwork(networkName).inspect();
  } catch (error) {
    if (isDockerNotFound(error)) {
      throw new DomainError("NOT_FOUND", "The factory network does not exist yet.", { rule: "network-required" });
    }
    throw toDockerDomainError(error, "inspect network");
  }
  if (!isManaged(details.Labels)) {
    throw new DomainError("INVARIANT", "Refusing to attach to a network that Z-Factory does not manage.", {
      rule: "managed-only",
    });
  }
}

/**
 * Creates (does not start) a runtime container from an allow-listed image on the
 * factory's network. The request is validated against the policy before Docker is asked.
 */
export async function createRuntimeContainer(
  docker: Docker,
  input: unknown,
  policy: RuntimePolicy,
): Promise<{ containerId: string; name: string; imageId: string }> {
  const spec = buildContainerSpec(input, policy);
  const networkName = spec.options.HostConfig?.NetworkMode ?? "";

  await assertManagedNetwork(docker, networkName);
  assertPortBindings(spec.ports, await listPublishedPorts(docker), policy);
  const { imageId } = await ensureImage(docker, spec.image);

  const container = await dockerCall("create container", () => docker.createContainer(spec.options));
  return { containerId: container.id, name: spec.options.name ?? "", imageId };
}

export async function startRuntimeContainer(docker: Docker, containerId: string): Promise<void> {
  const details = await inspectManaged(docker, containerId, "start container");
  if (details.State.Running) return;
  await dockerCall("start container", () => docker.getContainer(containerId).start());
}

export async function stopRuntimeContainer(docker: Docker, containerId: string, timeoutSeconds = 10): Promise<void> {
  const details = await inspectManaged(docker, containerId, "stop container");
  if (!details.State.Running) return;
  await dockerCall("stop container", () => docker.getContainer(containerId).stop({ t: timeoutSeconds }));
}

export async function restartRuntimeContainer(docker: Docker, containerId: string, timeoutSeconds = 10): Promise<void> {
  await inspectManaged(docker, containerId, "restart container");
  await dockerCall("restart container", () => docker.getContainer(containerId).restart({ t: timeoutSeconds }));
}

/** Stops and removes a runtime container. Returns false when it no longer exists. */
export async function removeRuntimeContainer(docker: Docker, containerId: string): Promise<boolean> {
  try {
    await inspectManaged(docker, containerId, "remove container");
  } catch (error) {
    if (error instanceof DomainError && error.code === "NOT_FOUND") return false;
    throw error;
  }
  await dockerCall("remove container", () => docker.getContainer(containerId).remove({ force: true, v: true }));
  return true;
}

/** Docker container state mapped onto the runtime states the UI knows. */
export function toRuntimeState(state: Docker.ContainerInspectInfo["State"]): RuntimeState {
  switch (state.Status) {
    case "running":
      if (state.Health?.Status === "starting") return "STARTING";
      return state.Health?.Status === "unhealthy" ? "DEGRADED" : "RUNNING";
    case "restarting":
      return "STARTING";
    case "removing":
      return "STOPPING";
    case "paused":
      return "DEGRADED";
    case "dead":
      return "FAULTED";
    case "exited":
      return state.ExitCode === 0 ? "STOPPED" : "FAULTED";
    default:
      return "STOPPED";
  }
}

export async function inspectRuntimeContainer(docker: Docker, containerId: string): Promise<RuntimeContainerStatus> {
  const details = await inspectManaged(docker, containerId, "inspect container");
  const labels = details.Config.Labels ?? {};

  const ports: PortBinding[] = [];
  for (const [key, bindings] of Object.entries(details.HostConfig.PortBindings ?? {})) {
    for (const binding of (bindings ?? []) as Array<{ HostIp?: string; HostPort?: string }>) {
      if (binding.HostPort) {
        ports.push({
          containerPort: Number.parseInt(key, 10),
          hostPort: Number(binding.HostPort),
          bindAddress: binding.HostIp ?? "",
        });
      }
    }
  }

  return {
    state: toRuntimeState(details.State),
    running: details.State.Running,
    exitCode: details.State.Status === "exited" ? details.State.ExitCode : null,
    startedAt: details.State.Running ? details.State.StartedAt : null,
    imageId: details.Image,
    factoryId: labels[LABEL_FACTORY_ID] ?? null,
    deviceId: labels[LABEL_DEVICE_ID] ?? null,
    ports,
    limits: {
      cpus: (details.HostConfig.NanoCpus ?? 0) / 1e9,
      memoryMb: Math.round((details.HostConfig.Memory ?? 0) / (1024 * 1024)),
      pidsLimit: details.HostConfig.PidsLimit ?? null,
    },
  };
}
