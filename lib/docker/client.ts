import "server-only";
import Docker from "dockerode";
import { getServerEnv } from "@/lib/env";

/**
 * Docker Engine access is privileged and server-only (ADR-0004). Nothing in this
 * directory may be imported by client code; identifiers returned from Docker stay on
 * the server and the UI works with Z-Factory ids.
 */

export function dockerOptionsFromHost(dockerHost: string): Docker.DockerOptions {
  if (dockerHost.startsWith("unix://")) return { socketPath: dockerHost.slice("unix://".length) };
  const url = new URL(dockerHost);
  return { host: url.hostname, port: Number(url.port), protocol: "http" };
}

export function createDockerClient(dockerHost: string): Docker {
  return new Docker(dockerOptionsFromHost(dockerHost));
}

const globalForDocker = globalThis as typeof globalThis & { zfactoryDocker?: Docker };

export function getDocker(): Docker {
  globalForDocker.zfactoryDocker ??= createDockerClient(getServerEnv().DOCKER_HOST);
  return globalForDocker.zfactoryDocker;
}
