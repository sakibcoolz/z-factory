import "server-only";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { runtimePolicyFromEnv } from "@/lib/docker/policy";
import { getServerEnv } from "@/lib/env";
import { resolveRuntimeSecret } from "@/lib/runtimes/openplc/credentials";
import type { RuntimeDeps } from "./plc-runtime-service";

/** Database, Docker client, runtime policy and secret for the runtime services, from the environment. */
export function getRuntimeDeps(): RuntimeDeps {
  const env = getServerEnv();
  return {
    db: getDb(),
    docker: getDocker(),
    policy: runtimePolicyFromEnv(env),
    runtimeSecret: resolveRuntimeSecret({ nodeEnv: process.env.NODE_ENV, runtimeSecret: env.RUNTIME_SECRET }),
  };
}
