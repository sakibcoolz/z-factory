import "server-only";
import { DomainError } from "@/lib/domain/errors";

type DockerError = { statusCode?: number; code?: string; reason?: string; message?: string };

const isDockerError = (error: unknown): error is DockerError => typeof error === "object" && error !== null;

/**
 * Turns Docker Engine failures into domain errors. The domain message never repeats the
 * daemon's text (it can contain host paths, image names of other projects and the like);
 * the original stays in `cause` for the server log.
 */
export function toDockerDomainError(error: unknown, action: string): DomainError {
  if (error instanceof DomainError) return error;
  const docker = isDockerError(error) ? error : {};
  const details = { action, statusCode: docker.statusCode, cause: docker.code ?? docker.reason };

  if (docker.code === "ENOENT" || docker.code === "ECONNREFUSED" || docker.code === "EACCES") {
    return new DomainError("RUNTIME_FAILURE", "The Docker Engine is not reachable.", details);
  }
  if (docker.statusCode === 404) {
    return new DomainError("NOT_FOUND", `Docker has no such resource (${action}).`, details);
  }
  if (docker.statusCode === 409) {
    return new DomainError("CONFLICT", `Docker refused the request because of a conflict (${action}).`, details);
  }
  return new DomainError("RUNTIME_FAILURE", `Docker could not complete the request (${action}).`, details);
}

/** Runs a Docker call, rethrowing its failures as domain errors. */
export async function dockerCall<T>(action: string, operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    throw toDockerDomainError(error, action);
  }
}

export function isDockerNotFound(error: unknown): boolean {
  return isDockerError(error) && error.statusCode === 404;
}
