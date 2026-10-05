/**
 * The process-module types shipped with Z-Factory, validated. `prisma/seed.ts` writes
 * them to the database with `ingestModuleTypes`.
 */
import type { ModuleTypeDefinition } from "@/lib/domain/process-module";
import { parseModuleType } from "@/lib/process-modules/schema";
import { shippedModuleTypes } from "@/lib/process-modules/types";

/** Throws when a shipped definition breaks the rules of a module type. */
export function loadModuleTypes(): ModuleTypeDefinition[] {
  return shippedModuleTypes.map((type) => parseModuleType(type));
}
