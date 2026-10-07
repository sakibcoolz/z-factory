import "server-only";
import { z } from "zod";

/**
 * Web Factory's server environment, checked once. Nothing here reaches a browser: there is
 * no NEXT_PUBLIC_ variable, and MQTT credentials are read from files on the server only.
 */
const brokerUrl = z
  .string()
  .url()
  .refine((value) => /^(mqtts?|tcp|ssl|tls):\/\//.test(value), "an mqtt://, mqtts://, tcp://, ssl:// or tls:// URL")
  .refine((value) => !/\/\/[^/]*@/.test(value), "credentials belong in the user name and password file, not the URL");

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_FACTORY_DATABASE_URL: z.string().url().startsWith("postgresql://"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_URL: z.string().url().optional(),
  WEB_FACTORY_MQTT_URL: brokerUrl.optional(),
  WEB_FACTORY_MQTT_USERNAME: z.string().optional(),
  WEB_FACTORY_MQTT_PASSWORD_FILE: z.string().optional(),
  WEB_FACTORY_MQTT_CA_FILE: z.string().optional(),
  WEB_FACTORY_MQTT_CLIENT_ID: z.string().min(1).max(128).optional(),
  /** The broker as agents reach it, shown when their credentials are issued. */
  WEB_FACTORY_MQTT_AGENT_URL: brokerUrl.optional(),
  /** The agents' heartbeat interval in seconds (ZFACTORY_AGENT_HEARTBEAT); 10 by default. */
  WEB_FACTORY_AGENT_HEARTBEAT_S: z.coerce.number().int().min(1).max(3600).optional(),
  /** Days of raw telemetry kept (TASK-903); older day partitions are dropped. */
  WEB_FACTORY_TELEMETRY_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(30),
  /** Telemetry batches held for writing; beyond it the oldest are dropped and counted. */
  WEB_FACTORY_TELEMETRY_QUEUE: z.coerce.number().int().min(100).max(1_000_000).default(10_000),
  /** Telemetry writers (database connections writing at once). */
  WEB_FACTORY_TELEMETRY_WRITERS: z.coerce.number().int().min(1).max(32).default(2),
});

export type ServerEnv = z.infer<typeof schema>;

export class EnvironmentError extends Error {
  constructor(readonly variables: string[]) {
    super(`Invalid or missing environment variables: ${variables.join(", ")}`);
    this.name = "EnvironmentError";
  }
}

/** Parses an environment; the error names the variables, never their values. */
export function parseServerEnv(source: Record<string, string | undefined>): ServerEnv {
  const result = schema.safeParse(source);
  if (!result.success) {
    throw new EnvironmentError([...new Set(result.error.issues.map((issue) => String(issue.path[0])))]);
  }
  return result.data;
}

let cached: ServerEnv | undefined;

export function getServerEnv(): ServerEnv {
  cached ??= parseServerEnv(process.env);
  return cached;
}
