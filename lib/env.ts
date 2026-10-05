import "server-only";
import { z } from "zod";

/** Environment contract (docs/bootstrap.md). Add a variable here, in `.env.example` and in the docs together. */
const postgresUrl = z
  .string()
  .min(1)
  .regex(/^postgres(ql)?:\/\//, "must be a postgresql:// connection string");

const serverEnvSchema = z.object({
  DATABASE_URL: postgresUrl,
  TEST_DATABASE_URL: postgresUrl.optional(),
  /** Single-owner mode (ADR-0007): the owner every factory operation is scoped to. */
  LOCAL_OWNER_ID: z
    .string()
    .regex(/^[A-Za-z0-9._-]{1,64}$/, "use 1-64 letters, digits, dots, hyphens or underscores")
    .optional(),
  /**
   * Secret the per-container runtime API credentials are derived from. Optional outside
   * production (a fixed development value is used); required in production.
   */
  RUNTIME_SECRET: z.string().min(32, "use at least 32 characters").optional(),
  /** Docker Engine endpoint: a unix socket or a TCP proxy. Never exposed to the browser. */
  DOCKER_HOST: z
    .string()
    .regex(/^(unix:\/\/\/.+|tcp:\/\/[A-Za-z0-9.-]+:\d{1,5})$/, "use unix:///path or tcp://host:port")
    .default("unix:///var/run/docker.sock"),
  /** Host ports runtime containers may publish, as `min-max`. */
  RUNTIME_PORT_RANGE: z
    .string()
    .regex(/^\d{1,5}-\d{1,5}$/, "use min-max, e.g. 15000-15999")
    .default("15000-15999"),
  /** Comma-separated host addresses runtime ports may bind to. */
  RUNTIME_BIND_ADDRESSES: z
    .string()
    .regex(/^\d{1,3}(\.\d{1,3}){3}(,\d{1,3}(\.\d{1,3}){3})*$/, "use comma-separated IPv4 addresses")
    .default("127.0.0.1"),
  /** Device-simulator cycle time in milliseconds. */
  SIMULATION_TICK_MS: z.coerce.number().int().min(20).max(5000).default(100),
  /** How often the simulator persists a state snapshot of its devices, in milliseconds. */
  SIMULATION_SNAPSHOT_MS: z.coerce.number().int().min(1000).max(3_600_000).default(10_000),
  /**
   * Directory the catalog's 3D assets are stored in (ADR-0012). Relative paths start at the
   * working directory of the server. Never served directly: files go out through a route.
   */
  ASSET_STORAGE_DIR: z
    .string()
    .min(1)
    .refine((path) => !path.includes("\0"), "must be a directory path")
    .default("./data/assets"),
  /** How often the tags of a running PLC are read for live values, in milliseconds. */
  TAG_POLL_MS: z.coerce.number().int().min(100).max(60_000).default(500),
  /** Telemetry: a tag is stored at most this often, in milliseconds. */
  TELEMETRY_MIN_INTERVAL_MS: z.coerce.number().int().min(100).max(3_600_000).default(1000),
  /** Telemetry: a tag is stored at least this often even when it does not change, in milliseconds. */
  TELEMETRY_MAX_INTERVAL_MS: z.coerce.number().int().min(1000).max(86_400_000).default(60_000),
  /** Telemetry: a change below this percentage of the last stored value is not stored. */
  TELEMETRY_DEADBAND_PERCENT: z.coerce.number().min(0).max(100).default(1),
  /** Stored telemetry samples older than this many hours are removed. */
  TELEMETRY_RETENTION_HOURS: z.coerce.number().int().min(1).max(8760).default(24),
  /** Recorded events and cleared alarms older than this many days are removed. */
  EVENT_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

export class EnvironmentError extends Error {
  constructor(readonly variables: readonly string[]) {
    // Variable names only: values may be credentials and must not reach logs.
    super(`Invalid or missing environment variables: ${variables.join(", ")}`);
    this.name = "EnvironmentError";
  }
}

export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = serverEnvSchema.safeParse(source);
  if (!result.success) {
    const variables = [...new Set(result.error.issues.map((issue) => String(issue.path[0])))];
    throw new EnvironmentError(variables);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

/** Validated server environment, parsed on first use so builds without a database still succeed. */
export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
