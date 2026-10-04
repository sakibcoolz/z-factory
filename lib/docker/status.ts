import "server-only";
import type Docker from "dockerode";

export type DockerEngineStatus = { reachable: true; version: string } | { reachable: false };

const TIMEOUT_MS = 1500;

/**
 * Whether the Docker Engine answers, for the host status shown in the UI. Never throws:
 * an unreachable engine is a state to display, not a page failure.
 */
export async function getDockerEngineStatus(docker: Docker): Promise<DockerEngineStatus> {
  let timer: NodeJS.Timeout | undefined;
  try {
    const version = await Promise.race([
      docker.version(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("timeout")), TIMEOUT_MS);
      }),
    ]);
    return { reachable: true, version: version.Version };
  } catch {
    return { reachable: false };
  } finally {
    clearTimeout(timer);
  }
}
