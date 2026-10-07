import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { getServerEnv } from "@/lib/env";
import { type Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** A client or an open transaction; services accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// One client per server process; survives dev hot reloads.
const globalForDb = globalThis as typeof globalThis & { webFactoryDb?: PrismaClient };

export function getDb(): PrismaClient {
  globalForDb.webFactoryDb ??= createPrismaClient(getServerEnv().WEB_FACTORY_DATABASE_URL);
  return globalForDb.webFactoryDb;
}
