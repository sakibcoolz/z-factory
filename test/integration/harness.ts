import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { createPrismaClient } from "@/lib/db/client";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import type { IoPointType, PlcArchitecture, PrismaClient } from "@/lib/generated/prisma/client";
import { assertTestDatabaseUrl } from "./test-database-url";

const url = process.env.TEST_DATABASE_URL;

/** `describe` that is skipped when no integration-test database is configured. */
export const describeDb = url ? describe : describe.skip;

export function openTestDb(): PrismaClient {
  if (!url) throw new Error("TEST_DATABASE_URL is not set.");
  assertTestDatabaseUrl(url);
  return createPrismaClient(url);
}

/** Empties every table and re-seeds the generic categories. */
export async function resetDb(db: PrismaClient): Promise<void> {
  const tables = await db.$queryRaw<Array<{ tablename: string }>>`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'
  `;
  const names = tables.map((table) => `"${table.tablename}"`).join(", ");
  await db.$executeRawUnsafe(`TRUNCATE TABLE ${names} RESTART IDENTITY CASCADE`);
  await db.deviceCategory.createMany({ data: [...GENERIC_CATEGORIES] });
}

let subnetCounter = 0;

export async function createFactory(db: PrismaClient, name: string, ownerId = "owner-1") {
  const id = randomUUID();
  subnetCounter += 1;
  return factoryRepository.create(db, {
    id,
    ownerId,
    name,
    slug: `${name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${subnetCounter}`,
    subnetCidr: `172.20.${subnetCounter}.0/24`,
    dockerNetworkName: `zfactory_${id}`,
  });
}

/**
 * Generic, simulated catalog models. They carry verification status GENERIC and no
 * vendor facts; signal codes are arbitrary normalized test values.
 */
export async function createGenericModel(
  db: PrismaClient,
  categoryCode: string,
  modelName: string,
  options: {
    architectureType?: PlcArchitecture;
    builtInChannels?: Array<{ ioType: IoPointType; channelIndex: number; signalType: string }>;
    ioDefinitions?: Array<{ direction: "INPUT" | "OUTPUT"; ioType: "DIGITAL" | "ANALOG"; signalType: string }>;
  } = {},
) {
  const manufacturer = await db.manufacturer.upsert({
    where: { name: "Generic / simulated" },
    create: { name: "Generic / simulated" },
    update: {},
  });
  const category = await db.deviceCategory.findUniqueOrThrow({ where: { code: categoryCode } });
  const family = await db.deviceFamily.upsert({
    where: { manufacturerId_name: { manufacturerId: manufacturer.id, name: `Generic ${categoryCode}` } },
    create: { manufacturerId: manufacturer.id, deviceCategoryId: category.id, name: `Generic ${categoryCode}` },
    update: {},
  });
  return db.deviceModel.create({
    data: {
      familyId: family.id,
      modelName,
      architectureType: options.architectureType,
      runtimeSupport: categoryCode === "PLC" ? "OPENPLC" : "DEVICE_SIM",
      verificationStatus: "GENERIC",
      builtInIoChannels: { create: options.builtInChannels ?? [] },
      ioDefinitions: { create: options.ioDefinitions ?? [] },
    },
    include: { builtInIoChannels: true, ioDefinitions: true },
  });
}
