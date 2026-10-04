import "server-only";
import { PrismaPg } from "@prisma/adapter-pg";
import { getServerEnv } from "@/lib/env";
import { type Prisma, PrismaClient } from "@/lib/generated/prisma/client";

/** A client or an open transaction; repositories accept either. */
export type Db = PrismaClient | Prisma.TransactionClient;

export function createPrismaClient(connectionString: string): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
}

// One client per server process; survives dev hot reloads.
const globalForDb = globalThis as typeof globalThis & { zfactoryDb?: PrismaClient };

export function getDb(): PrismaClient {
  globalForDb.zfactoryDb ??= createPrismaClient(getServerEnv().DATABASE_URL);
  return globalForDb.zfactoryDb;
}
