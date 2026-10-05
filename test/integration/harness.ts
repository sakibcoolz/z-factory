import { randomUUID } from "node:crypto";
import { describe } from "vitest";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { createPrismaClient } from "@/lib/db/client";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import type { IoPointType, PlcArchitecture, PrismaClient } from "@/lib/generated/prisma/client";
import { connectWire, getPairWiring } from "@/lib/services/wiring-service";
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

/**
 * Wires every signal terminal of a device to the first channel of the PLC that takes it,
 * one wire at a time through the wiring service: what a person does in the wiring editor.
 */
export async function wireAllSignals(
  db: PrismaClient,
  actor: { ownerId: string },
  factoryId: string,
  plcId: string,
  deviceId: string,
): Promise<number> {
  const terminals = (await getPairWiring(db, actor, factoryId, deviceId, plcId)).first.endpoints.filter(
    (endpoint) => endpoint.kind === "SIGNAL",
  );
  for (const terminal of terminals) {
    // Read again for every wire: the channel the last one took is no longer free.
    const view = await getPairWiring(db, actor, factoryId, deviceId, plcId);
    const channel = view.second.endpoints.find(
      (endpoint) => endpoint.type === "PLC_IO_POINT" && view.refusals[terminal.key]?.[endpoint.key] === undefined,
    );
    if (!channel)
      throw new Error(`${view.first.name} / ${terminal.label} finds no free channel on ${view.second.name}`);
    await connectWire(db, actor, factoryId, {
      from: { deviceId, type: terminal.type, id: terminal.id },
      to: { deviceId: plcId, type: channel.type, id: channel.id },
    });
  }
  return terminals.length;
}
