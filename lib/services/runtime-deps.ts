import "server-only";
import { getDb } from "@/lib/db/client";
import { getDocker } from "@/lib/docker/client";
import { runtimePolicyFromEnv } from "@/lib/docker/policy";
import { getServerEnv } from "@/lib/env";
import { getEventBus } from "@/lib/events/bus";
import { getDeviceSimulator } from "@/lib/runtimes/device-sim/runtime";
import { getTagMonitor } from "@/lib/runtimes/tag-monitor/monitor";
import { resolveRuntimeSecret } from "@/lib/runtimes/openplc/credentials";
import type { LiveDeps } from "./live-service";
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
    bus: getEventBus(),
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

/** Database, bus, tag monitor and simulator for the live service, with its timing from the environment. */
export function getLiveDeps(): LiveDeps {
  const env = getServerEnv();
  return {
    db: getDb(),
    bus: getEventBus(),
    monitor: getTagMonitor(),
    simulator: getDeviceSimulator(),
    pollMs: env.TAG_POLL_MS,
    sampling: {
      minIntervalMs: env.TELEMETRY_MIN_INTERVAL_MS,
      maxIntervalMs: Math.max(env.TELEMETRY_MAX_INTERVAL_MS, env.TELEMETRY_MIN_INTERVAL_MS),
      deadbandRatio: env.TELEMETRY_DEADBAND_PERCENT / 100,
    },
    retention: {
      telemetryMs: env.TELEMETRY_RETENTION_HOURS * 3_600_000,
      eventsMs: env.EVENT_RETENTION_DAYS * 86_400_000,
    },
  };
}
