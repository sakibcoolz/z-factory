/**
 * Integration tests truncate every table, so they only ever run against a database
 * whose name ends in `_test`. This guards against pointing them at real data.
 */
export function assertTestDatabaseUrl(url: string): void {
  const databaseName = new URL(url).pathname.replace(/^\//, "");
  if (!databaseName.endsWith("_test")) {
    throw new Error(`TEST_DATABASE_URL must name a database ending in "_test" (got "${databaseName}").`);
  }
}
