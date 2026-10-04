import "server-only";
import type { Db } from "@/lib/db/client";
import { withDomainErrors } from "@/lib/db/errors";
import type { Factory } from "@/lib/generated/prisma/client";

export type NewFactory = {
  id: string;
  ownerId: string;
  name: string;
  slug: string;
  description?: string;
  subnetCidr: string;
  dockerNetworkName: string;
};

export type FactoryChanges = Partial<Pick<Factory, "name" | "slug" | "description" | "subnetCidr" | "status">>;

const withSummary = {
  devices: { select: { plcProfile: { select: { deviceInstanceId: true } } } },
  events: { orderBy: { occurredAt: "desc" }, take: 1, select: { type: true, occurredAt: true } },
} as const;

/** Every query is scoped by owner so one owner can never read or change another owner's factory. */
export const factoryRepository = {
  create(db: Db, data: NewFactory): Promise<Factory> {
    return withDomainErrors(() => db.factory.create({ data }));
  },

  list(db: Db, ownerId: string): Promise<Factory[]> {
    return db.factory.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
  },

  /** Factories with what the list screen shows: device/PLC counts and the latest event. */
  listWithSummary(db: Db, ownerId: string) {
    return db.factory.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" }, include: withSummary });
  },

  findById(db: Db, ownerId: string, id: string): Promise<Factory | null> {
    return db.factory.findFirst({ where: { id, ownerId } });
  },

  findWithSummary(db: Db, ownerId: string, id: string) {
    return db.factory.findFirst({ where: { id, ownerId }, include: withSummary });
  },

  findBySlug(db: Db, ownerId: string, slug: string): Promise<Factory | null> {
    return db.factory.findFirst({ where: { slug, ownerId } });
  },

  /**
   * Subnets of every factory on this host, across owners: Docker networks share one
   * address space. Only the CIDRs are returned, never whose they are.
   */
  async listSubnets(db: Db, excludeFactoryId?: string): Promise<string[]> {
    const rows = await db.factory.findMany({
      where: excludeFactoryId ? { id: { not: excludeFactoryId } } : undefined,
      select: { subnetCidr: true },
    });
    return rows.map((row) => row.subnetCidr);
  },

  /** Returns the number of rows changed: 0 when the factory does not exist for this owner. */
  async update(db: Db, ownerId: string, id: string, changes: FactoryChanges): Promise<number> {
    const result = await withDomainErrors(() => db.factory.updateMany({ where: { id, ownerId }, data: changes }));
    return result.count;
  },

  async delete(db: Db, ownerId: string, id: string): Promise<number> {
    const result = await withDomainErrors(() => db.factory.deleteMany({ where: { id, ownerId } }));
    return result.count;
  },

  recordEvent(db: Db, event: { factoryId: string; type: string; payloadJson: Record<string, string> }) {
    return db.runtimeEvent.create({ data: event });
  },
};
