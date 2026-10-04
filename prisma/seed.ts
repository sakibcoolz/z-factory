/**
 * Seeds generic device categories only. Idempotent: safe to run repeatedly.
 *
 * Vendor catalog data is deliberately NOT seeded here. Named manufacturer/model records
 * enter through the verified, provenance-carrying ingestion of TASK-301
 * (docs/references/plc-source-policy.md).
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { GENERIC_CATEGORIES } from "../lib/catalog/generic-categories";
import { PrismaClient } from "../lib/generated/prisma/client";

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is not set.");

  const db = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  try {
    for (const category of GENERIC_CATEGORIES) {
      await db.deviceCategory.upsert({
        where: { code: category.code },
        create: category,
        update: { name: category.name, simulatorType: category.simulatorType, requiresMotor: category.requiresMotor },
      });
    }
    console.log(`Seeded ${GENERIC_CATEGORIES.length} generic device categories.`);
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
