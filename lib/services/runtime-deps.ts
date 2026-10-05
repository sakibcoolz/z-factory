import "server-only";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { runtimePolicyFromEnv } from "@/lib/docker/policy";
import { getServerEnv } from "@/lib/env";
import { getEventBus } from "@/lib/events/bus";
import { getDeviceSimulator } from "@/lib/runtimes/device-sim/runtime";
import { resolveRuntimeSecret } from "@/lib/runtimes/openplc/credentials";
import type { RuntimeDeps } from "./plc-runtime-service";
import type { SimulationDeps } from "./simulation-service";

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

/** Database, the shared device simulator and its timing for the simulation service, from the environment. */
export function getSimulationDeps(): SimulationDeps {
  const env = getServerEnv();
  return {
    db: getDb(),
    simulator: getDeviceSimulator(),
    tickMs: env.SIMULATION_TICK_MS,
    snapshotIntervalMs: env.SIMULATION_SNAPSHOT_MS,
    bus: getEventBus(),
  };
}
