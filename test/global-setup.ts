import "dotenv/config";
import { execFileSync } from "node:child_process";
import { assertTestDatabaseUrl } from "./integration/test-database-url";

/**
 * Applies committed migrations to the integration-test database once per run.
 * Integration tests are skipped entirely when TEST_DATABASE_URL is not set.
 */
export default function setup() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) return;
  assertTestDatabaseUrl(url);
  execFileSync("npx", ["prisma", "migrate", "deploy"], {
    env: { ...process.env, DATABASE_URL: url },
    stdio: "pipe",
  });
}
