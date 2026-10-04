import "server-only";
import type Docker from "dockerode";
import { DomainError } from "@/lib/domain/errors";
import { dockerCall, isDockerNotFound } from "./errors";
import type { RuntimeImage } from "./policy";

/** `repository:tag`, pinned to the digest when the allow-list records one. */
export function imageReference(image: RuntimeImage): string {
  return image.digest ? `${image.reference}@${image.digest}` : image.reference;
}

async function inspectImage(docker: Docker, reference: string) {
  try {
    return await docker.getImage(reference).inspect();
  } catch (error) {
    if (isDockerNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * Makes an allow-listed image available locally, pulling it when missing, and returns
 * its content id so the runtime configuration can record exactly what ran.
 */
export async function ensureImage(docker: Docker, image: RuntimeImage): Promise<{ imageId: string }> {
  const reference = imageReference(image);
  let details = await dockerCall("inspect image", () => inspectImage(docker, reference));

  if (!details) {
    await dockerCall("pull image", async () => {
      const stream = await docker.pull(reference);
      await new Promise<void>((resolve, reject) => {
        docker.modem.followProgress(stream, (error) => (error ? reject(error) : resolve()));
      });
    });
    details = await dockerCall("inspect image", () => inspectImage(docker, reference));
  }
  if (!details) {
    throw new DomainError("RUNTIME_FAILURE", "The runtime image is not available after pulling it.", {
      image: image.key,
    });
  }
  if (image.digest && !details.RepoDigests?.some((repoDigest) => repoDigest.endsWith(`@${image.digest}`))) {
    throw new DomainError("INVARIANT", "The runtime image does not match its pinned digest.", { image: image.key });
  }
  return { imageId: details.Id };
}
