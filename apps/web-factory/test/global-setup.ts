import { execSync } from "node:child_process";
import "dotenv/config";

/** Brings the test database to the current schema before the integration tests. */
export default function setup() {
  const url = process.env.WEB_FACTORY_TEST_DATABASE_URL;
  if (!url) return;
  execSync("npx prisma migrate deploy", { stdio: "ignore", env: { ...process.env, WEB_FACTORY_DATABASE_URL: url } });
}
