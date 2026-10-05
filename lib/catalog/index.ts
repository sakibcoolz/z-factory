/**
 * The catalog shipped with Z-Factory: verified vendor records and generic simulated
 * models. `prisma/seed.ts` writes it to the database with `ingestCatalog`.
 */
import { genericModels } from "@/lib/catalog/generic-models";
import { type Catalog, type CatalogInput, parseCatalog } from "@/lib/catalog/schema";
import { rockwell } from "@/lib/catalog/vendor/rockwell";
import { schneider } from "@/lib/catalog/vendor/schneider";
import { siemens } from "@/lib/catalog/vendor/siemens";

export function mergeCatalogs(parts: readonly CatalogInput[]): CatalogInput {
  return {
    manufacturers: parts.flatMap((part) => part.manufacturers),
    models: parts.flatMap((part) => part.models),
    racks: parts.flatMap((part) => part.racks ?? []),
    modules: parts.flatMap((part) => part.modules ?? []),
  };
}

/** The shipped catalog, validated. Throws when a definition breaks the catalog rules. */
export function loadCatalog(): Catalog {
  return parseCatalog(mergeCatalogs([siemens, rockwell, schneider, genericModels]));
}
