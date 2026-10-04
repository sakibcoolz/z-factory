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
