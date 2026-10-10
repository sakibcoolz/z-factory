import "server-only";
import type Docker from "dockerode";
import { OPENPLC_IMAGE_KEY, RUNTIME_IMAGES } from "./runtime-images";

/** The pinned OpenPLC runtime image's tag, shown with the host status (TASK-1005). */
const openPlcImage =
  (RUNTIME_IMAGES.find((image) => image.key === OPENPLC_IMAGE_KEY)?.reference ?? "").split(":").pop() ?? "";

export type DockerEngineStatus = ({ reachable: true; version: string } | { reachable: false }) & {
  /** The tag of the pinned OpenPLC runtime image, what a PLC starts with. */
  openPlcImage: string;
};

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
    return { reachable: true, version: version.Version, openPlcImage };
  } catch {
    return { reachable: false, openPlcImage };
  } finally {
    clearTimeout(timer);
  }
}
