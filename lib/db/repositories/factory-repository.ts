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

/** Every query is scoped by owner so one owner can never read or change another owner's factory. */
export const factoryRepository = {
  create(db: Db, data: NewFactory): Promise<Factory> {
    return withDomainErrors(() => db.factory.create({ data }));
  },

  list(db: Db, ownerId: string): Promise<Factory[]> {
    return db.factory.findMany({ where: { ownerId }, orderBy: { createdAt: "asc" } });
  },

  findById(db: Db, ownerId: string, id: string): Promise<Factory | null> {
    return db.factory.findFirst({ where: { id, ownerId } });
  },

  findBySlug(db: Db, ownerId: string, slug: string): Promise<Factory | null> {
    return db.factory.findFirst({ where: { slug, ownerId } });
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
};
