/**
 * Seeds the generic device categories and the shipped catalog: verified vendor records
 * with their source provenance, and generic simulated models. Idempotent: safe to run
 * repeatedly (docs/device-catalog.md, docs/references/plc-source-policy.md).
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { loadCatalog } from "../lib/catalog";
import { ingestCatalog } from "../lib/catalog/ingest";
import { PrismaClient } from "../lib/generated/prisma/client";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    const result = await ingestCatalog(db, loadCatalog());
    console.log(
      `Seeded ${result.categories} categories, ${result.manufacturers} manufacturers, ${result.models} models, ` +
        `${result.racks} racks and ${result.modules} modules.`,
    );
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
