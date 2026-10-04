import "server-only";
import { DomainError } from "@/lib/domain/errors";
import type { ServerEnv } from "@/lib/env";
import { RUNTIME_IMAGES } from "./runtime-images";

/**
 * What the application may ask Docker to do. Requests are checked against this policy
 * before any Docker call (docs/security.md, ADR-0004); nothing outside it is reachable.
 */

/** An image the application may run. Callers select it by `key`; they never supply a reference. */
export type RuntimeImage = {
  key: string;
  /** `repository:tag`. */
  reference: string;
  /** `sha256:…`; when set, the pulled image must match it. */
  digest?: string;
  /** Fixed command. A request can never supply a command or entrypoint. */
  command?: readonly string[];
  /** Container ports that may be published to the host. */
  publishablePorts: readonly number[];
  /** Environment variable names a request may set. */
  allowedEnv: readonly string[];
};

export type RuntimeLimits = {
  defaultCpus: number;
  maxCpus: number;
  defaultMemoryMb: number;
  maxMemoryMb: number;
  pidsLimit: number;
};

export type RuntimePolicy = {
  images: readonly RuntimeImage[];
  /** Inclusive host port range runtime containers may publish. */
  portRange: { min: number; max: number };
  bindAddresses: readonly string[];
  limits: RuntimeLimits;
  /** Extra labels stamped on every created resource (used to scope test runs). */
  labels?: Readonly<Record<string, string>>;
};

export const DEFAULT_LIMITS: RuntimeLimits = {
  defaultCpus: 1,
  maxCpus: 2,
  defaultMemoryMb: 256,
  maxMemoryMb: 1024,
  pidsLimit: 256,
};

export function parsePortRange(range: string): { min: number; max: number } {
  const [min = 0, max = 0] = range.split("-").map(Number);
  // Privileged ports are never published; the range must be ordered.
  if (min < 1024 || max > 65535 || min > max) {
    throw new DomainError("VALIDATION", "RUNTIME_PORT_RANGE must be min-max within 1024-65535.", {
      rule: "port-range",
    });
  }
  return { min, max };
}

export function runtimePolicyFromEnv(
  env: Pick<ServerEnv, "RUNTIME_PORT_RANGE" | "RUNTIME_BIND_ADDRESSES">,
): RuntimePolicy {
  return {
    images: RUNTIME_IMAGES,
    portRange: parsePortRange(env.RUNTIME_PORT_RANGE),
    bindAddresses: env.RUNTIME_BIND_ADDRESSES.split(","),
    limits: DEFAULT_LIMITS,
  };
}
