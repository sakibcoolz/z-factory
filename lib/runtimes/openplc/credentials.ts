import "server-only";
import { createHmac } from "node:crypto";
import { DomainError } from "@/lib/domain/errors";

/**
 * API credentials of one OpenPLC runtime container, derived from the server secret and
 * the device id. Nothing is stored: the same device always gets the same password, and
 * a recreated container (which starts with no users) simply gets it again.
 */
export function runtimeCredentials(runtimeSecret: string, deviceId: string): { username: string; password: string } {
  const password = createHmac("sha256", runtimeSecret).update(`openplc-api:${deviceId}`).digest("base64url");
  return { username: "zfactory", password };
}

const DEVELOPMENT_RUNTIME_SECRET = "z-factory-development-runtime-secret";

/**
 * The secret behind the runtime API credentials. Outside production a fixed development
 * value is used; a production process must be given `RUNTIME_SECRET`.
 */
export function resolveRuntimeSecret(options: {
  nodeEnv: string | undefined;
  runtimeSecret: string | undefined;
}): string {
  if (options.runtimeSecret) return options.runtimeSecret;
  if (options.nodeEnv !== "production") return DEVELOPMENT_RUNTIME_SECRET;
  throw new DomainError("RUNTIME_FAILURE", "RUNTIME_SECRET is not configured for this deployment.", {
    rule: "runtime-secret-required",
  });
}
