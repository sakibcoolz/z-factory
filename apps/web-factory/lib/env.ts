import "server-only";
import { z } from "zod";

/**
 * Web Factory's server environment, checked once. Nothing here reaches a browser: there is
 * no NEXT_PUBLIC_ variable, and MQTT credentials are read from files on the server only.
 */
const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  WEB_FACTORY_DATABASE_URL: z.string().url().startsWith("postgresql://"),
  AUTH_SECRET: z.string().min(32, "AUTH_SECRET must be at least 32 characters"),
  AUTH_URL: z.string().url().optional(),
  WEB_FACTORY_MQTT_URL: z
    .string()
    .url()
    .refine((value) => /^(mqtts?|tcp|ssl|tls):\/\//.test(value), "an mqtt://, mqtts://, tcp://, ssl:// or tls:// URL")
    .refine((value) => !/\/\/[^/]*@/.test(value), "credentials belong in the user name and password file, not the URL")
    .optional(),
  WEB_FACTORY_MQTT_USERNAME: z.string().optional(),
  WEB_FACTORY_MQTT_PASSWORD_FILE: z.string().optional(),
  WEB_FACTORY_MQTT_CA_FILE: z.string().optional(),
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
