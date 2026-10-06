import "server-only";
import type { Actor } from "@/lib/auth/actor";
import { processBridgeRepository, type ProcessTagRecord } from "@/lib/db/repositories/process-bridge-repository";
import { type ModuleRecord, processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { DomainError } from "@/lib/domain/errors";
import {
  buildModuleIo,
  MODULE_IO_EXPORT_SCHEMA,
  MODULE_IO_EXPORT_SCHEMA_VERSION,
  type ModuleIoCandidate,
  type ModuleIoExportDocument,
  type ModuleIoRegistry,
} from "@/lib/domain/module-io-view";
import { checkProcessMapping, processFlow } from "@/lib/domain/process-bridge";
import { appliesToProfile, type ModuleSignal } from "@/lib/domain/process-module";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { toModuleTypeDefinition } from "@/lib/process-modules/ingest";
import { parseInput } from "@/lib/validation/parse";
import { moduleBindingInputSchema, moduleIoImportSchema } from "@/lib/validation/process-module";
import { getFactory } from "./factory-service";
import type { ProcessMappingInput } from "./process-bridge-service";
import { loadModule, storedBindings, toModuleDetail, toSignalTag } from "./process-module-service";

/**
 * The module PLC I/O registry (TASK-605, docs/process-modules.md → Module PLC I/O Registry):
 * which PLC inputs and outputs a process module consumes, which tag each signal is bound
 * to, and whether the module may run. A binding is a `ModulePlcIoMapping` row: it points at
 * a normal tag of a PLC of the same factory and adds no address space of its own. The rules
 * of `lib/domain/process-bridge.ts` decide what may be bound; the process bridge (TASK-603)
 * reads the stored bindings to run the module.
 */

type Tx = Parameters<typeof processModuleRepository.lockModule>[0];

function registryOf(record: ModuleRecord): ModuleIoRegistry {
  const type = toModuleTypeDefinition(record.processModuleType);
  const io = buildModuleIo(type.signals, record.profile, storedBindings(record));
  const detail = toModuleDetail(record);
  return {
    moduleId: record.id,
    name: record.name,
    profile: record.profile,
    type: { code: type.code, name: type.name, version: type.version, simulatorModelType: type.simulatorModelType },
    readyToRun: detail.readyToRun,
    rows: io.rows,
    internal: io.internal,
    counts: io.counts,
    plcs: io.plcs,
  };
}

/** The consumed-I/O list of a module: every signal of its profile with its binding and state. */
export async function getModuleIoRegistry(db: PrismaClient, actor: Actor, moduleId: string): Promise<ModuleIoRegistry> {
  return registryOf(await loadModule(db, actor, moduleId));
}

/** The signal of the module's profile a binding is about; INTERNAL signals have no binding. */
function bindableSignal(record: ModuleRecord, signalKey: string): ModuleSignal & { id: string } {
  const definition = record.processModuleType.signals.find((candidate) => candidate.key === signalKey);
  const signal = toModuleTypeDefinition(record.processModuleType).signals.find(
    (candidate) => candidate.key === signalKey,
  );
  if (!definition || !signal) {
    throw new DomainError("NOT_FOUND", `This module type has no signal ${signalKey}.`, { field: "signalKey" });
  }
  if (!appliesToProfile(signal, record.profile)) {
    throw new DomainError("INCOMPATIBLE", `The profile ${record.profile} has no ${signal.name}.`, {
      rule: "module-signal-profile",
      signalKey,
    });
  }
  if (!processFlow(signal.direction)) {
    throw new DomainError(
      "INCOMPATIBLE",
      `${signal.name} is internal to the process model; it is not bound to a tag.`,
      {
        rule: "module-signal-direction",
        signalKey,
      },
    );
  }
  return { ...signal, id: definition.id };
}

/** The tag, if it is one of a PLC of the module's factory. */
async function factoryTag(db: Tx | PrismaClient, record: ModuleRecord, tagId: string): Promise<ProcessTagRecord> {
  const [tag] = await processBridgeRepository.findTags(db, record.factoryId, [tagId]);
  if (!tag) throw new DomainError("NOT_FOUND", "The tag does not exist in this factory.", { field: "tagId" });
  return tag;
}

/** Refuses a tag another module (or another signal of this one) holds. */
async function assertTagFree(db: Tx, record: ModuleRecord, tagId: string, exceptMappingId?: string): Promise<void> {
  const holder = await processModuleRepository.findMappingByTag(db, tagId);
  if (!holder || holder.id === exceptMappingId) return;
  throw new DomainError(
    "OCCUPIED_ENDPOINT",
    `This tag already carries ${holder.moduleSignalDefinition.name} of ${holder.processModuleInstance.name}.`,
    { rule: "tag-mapped", module: holder.processModuleInstance.name, signal: holder.moduleSignalDefinition.key },
  );
}

/**
 * Binds a signal of the module to a tag of a PLC of the same factory. The tag has to be
 * free and pass the bridge rules for the signal. A signal that is already bound is refused:
 * `rebindModuleSignal` moves it. The module's row is locked while the binding is made, so
 * two bindings cannot both take the same signal.
 */
export async function bindModuleSignal(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleIoRegistry> {
  const data = parseInput(moduleBindingInputSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const signal = bindableSignal(record, data.signalKey);
  const tag = await factoryTag(db, record, data.tagId);
  checkProcessMapping(signal, toSignalTag(tag));

  await db.$transaction(async (transaction) => {
    await processModuleRepository.lockModule(transaction, record.id);
    const fresh = await processModuleRepository.findModule(transaction, actor.ownerId, record.id);
    const bound = fresh?.mappings.find((mapping) => mapping.moduleSignalDefinitionId === signal.id);
    if (bound) {
      throw new DomainError(
        "CONFLICT",
        `${signal.name} is already bound to tag ${bound.tag.name}; rebind or release it.`,
        {
          rule: "signal-bound",
          signalKey: signal.key,
          tag: bound.tag.name,
        },
      );
    }
    await assertTagFree(transaction, record, tag.id);
    await processModuleRepository.createMapping(transaction, {
      moduleId: record.id,
      signalId: signal.id,
      plcId: tag.plcInstanceId,
      tagId: tag.id,
    });
  });
  return getModuleIoRegistry(db, actor, record.id);
}

/** Moves a bound signal to another tag, under the same rules as binding it. */
export async function rebindModuleSignal(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleIoRegistry> {
  const data = parseInput(moduleBindingInputSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const signal = bindableSignal(record, data.signalKey);
  const tag = await factoryTag(db, record, data.tagId);
  checkProcessMapping(signal, toSignalTag(tag));

  await db.$transaction(async (transaction) => {
    await processModuleRepository.lockModule(transaction, record.id);
    const fresh = await processModuleRepository.findModule(transaction, actor.ownerId, record.id);
    const bound = fresh?.mappings.find((mapping) => mapping.moduleSignalDefinitionId === signal.id);
    if (!bound) {
      throw new DomainError("CONFLICT", `${signal.name} is not bound yet; bind it.`, {
        rule: "signal-unbound",
        signalKey: signal.key,
      });
    }
    await assertTagFree(transaction, record, tag.id, bound.id);
    await processModuleRepository.updateMapping(transaction, bound.id, { plcId: tag.plcInstanceId, tagId: tag.id });
  });
  return getModuleIoRegistry(db, actor, record.id);
}

/** Releases a signal's tag. The tag, the PLC and the module stay as they are. */
export async function releaseModuleSignal(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  signalKey: string,
): Promise<ModuleIoRegistry> {
  const record = await loadModule(db, actor, moduleId);
  const bound = record.mappings.find((mapping) => mapping.moduleSignalDefinition.key === signalKey);
  if (!bound) throw new DomainError("NOT_FOUND", `${signalKey} is not bound.`, { field: "signalKey" });
  await processModuleRepository.deleteMapping(db, record.id, bound.id);
  return getModuleIoRegistry(db, actor, record.id);
}

/**
 * Every tag of the factory's PLCs as a candidate for one signal: free and compatible ones
 * without a refusal, the others with the rule that refuses them, so a picker can show both.
 */
export async function listBindableTags(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  signalKey: string,
): Promise<ModuleIoCandidate[]> {
  const record = await loadModule(db, actor, moduleId);
  const signal = bindableSignal(record, signalKey);
  const own = record.mappings.find((mapping) => mapping.moduleSignalDefinition.key === signalKey);
  const tags = await processModuleRepository.listFactoryTags(db, record.factoryId);
  return tags.map((tag) => {
    const held = tag.moduleMapping;
    let refusal: ModuleIoCandidate["refusal"] = null;
    if (held && tag.id !== own?.tagId) {
      refusal = {
        rule: "tag-mapped",
        message: `Carries ${held.moduleSignalDefinition.key} of ${held.processModuleInstance.name}.`,
      };
    } else {
      try {
        checkProcessMapping(signal, toSignalTag(tag));
      } catch (error) {
        if (!(error instanceof DomainError)) throw error;
        refusal = {
          rule: error.details.rule as Exclude<ModuleIoCandidate["refusal"], null>["rule"],
          message: error.message,
        };
      }
    }
    return {
      tagId: tag.id,
      plcId: tag.plcInstanceId,
      plcName: tag.plc.deviceInstance.name,
      tagName: tag.name,
      logicalAddress: tag.logicalAddress,
      dataType: tag.dataType,
      role: tag.role,
      unit: tag.unit,
      refusal,
      heldBy: held ? { module: held.processModuleInstance.name, signal: held.moduleSignalDefinition.key } : null,
    };
  });
}

/** What every PLC of a factory gives to process modules, and what every module takes. */
export type FactoryIoSummary = {
  plcs: Array<{ plcId: string; plcName: string; modules: string[]; inputs: number; outputs: number; alarms: number }>;
  modules: Array<{ moduleId: string; name: string; bound: number }>;
};

export async function getFactoryIoSummary(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
): Promise<FactoryIoSummary> {
  const factory = await getFactory(db, actor, factoryId);
  const mappings = await processModuleRepository.listFactoryMappings(db, factory.id);
  const plcs = new Map<string, FactoryIoSummary["plcs"][number]>();
  const modules = new Map<string, FactoryIoSummary["modules"][number]>();
  for (const mapping of mappings) {
    const plc = plcs.get(mapping.plcInstanceId) ?? {
      plcId: mapping.plcInstanceId,
      plcName: mapping.plc.deviceInstance.name,
      modules: [],
      inputs: 0,
      outputs: 0,
      alarms: 0,
    };
    if (!plc.modules.includes(mapping.processModuleInstance.name)) plc.modules.push(mapping.processModuleInstance.name);
    const direction = mapping.moduleSignalDefinition.direction;
    if (direction === "INPUT") plc.inputs += 1;
    else if (direction === "OUTPUT") plc.outputs += 1;
    else if (direction === "ALARM") plc.alarms += 1;
    plcs.set(plc.plcId, plc);
    const use = modules.get(mapping.processModuleInstanceId) ?? {
      moduleId: mapping.processModuleInstanceId,
      name: mapping.processModuleInstance.name,
      bound: 0,
    };
    use.bound += 1;
    modules.set(use.moduleId, use);
  }
  return {
    plcs: [...plcs.values()].sort((a, b) => a.plcName.localeCompare(b.plcName)),
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

/** The stored bindings of a factory in the form the process bridge takes. */
export async function listFactoryModuleMappings(
  db: PrismaClient,
  actor: Actor,
  factoryId: string,
): Promise<ProcessMappingInput[]> {
  const factory = await getFactory(db, actor, factoryId);
  return (await processModuleRepository.listFactoryMappings(db, factory.id)).map((mapping) => ({
    moduleId: mapping.processModuleInstanceId,
    signalKey: mapping.moduleSignalDefinition.key,
    tagId: mapping.tagId,
  }));
}

/** The module's bindings by names: PLC and tag, per signal. Another installation rebuilds them with `importModuleIo`. */
export async function exportModuleIo(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
): Promise<ModuleIoExportDocument> {
  const registry = await getModuleIoRegistry(db, actor, moduleId);
  return {
    schema: MODULE_IO_EXPORT_SCHEMA,
    schemaVersion: MODULE_IO_EXPORT_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    module: {
      name: registry.name,
      type: registry.type.code,
      version: registry.type.version,
      profile: registry.profile,
    },
    bindings: registry.rows.flatMap((row) =>
      row.binding
        ? [
            {
              signal: row.signal.key,
              direction: row.signal.direction,
              plc: row.binding.plcName,
              tag: row.binding.tagName,
              logicalAddress: row.binding.logicalAddress,
              dataType: row.binding.dataType,
            },
          ]
        : [],
    ),
  };
}

/**
 * Replaces the module's bindings with those of a document, all or nothing. PLCs and tags
 * are found by name in the module's factory; the document has to be of the module's type
 * version and profile, so every signal it names exists.
 */
export async function importModuleIo(
  db: PrismaClient,
  actor: Actor,
  moduleId: string,
  input: unknown,
): Promise<ModuleIoRegistry> {
  const document = parseInput(moduleIoImportSchema, input);
  const record = await loadModule(db, actor, moduleId);
  const type = toModuleTypeDefinition(record.processModuleType);
  if (document.module.type !== type.code || document.module.version !== type.version) {
    throw new DomainError(
      "INCOMPATIBLE",
      `The document is for ${document.module.type} v${document.module.version}; this module is ${type.code} v${type.version}.`,
      { rule: "module-io-type" },
    );
  }
  if (document.module.profile !== record.profile) {
    throw new DomainError(
      "INCOMPATIBLE",
      `The document is for profile ${document.module.profile}; this module has ${record.profile}.`,
      {
        rule: "module-io-profile",
      },
    );
  }
  const tags = await processModuleRepository.listFactoryTags(db, record.factoryId);
  const resolved = document.bindings.map((binding) => {
    const signal = bindableSignal(record, binding.signal);
    const tag = tags.find(
      (candidate) => candidate.plc.deviceInstance.name === binding.plc && candidate.name === binding.tag,
    );
    if (!tag) {
      throw new DomainError("NOT_FOUND", `This factory has no tag ${binding.tag} on ${binding.plc}.`, {
        rule: "module-io-tag",
        signalKey: binding.signal,
      });
    }
    checkProcessMapping(signal, toSignalTag(tag));
    return { signal, tag };
  });
  const seen = new Set<string>();
  for (const { signal } of resolved) {
    if (seen.has(signal.key)) {
      throw new DomainError("VALIDATION", `${signal.name} is listed twice.`, {
        rule: "duplicate-signal",
        signalKey: signal.key,
      });
    }
    seen.add(signal.key);
  }

  await db.$transaction(async (transaction) => {
    await processModuleRepository.lockModule(transaction, record.id);
    await processModuleRepository.deleteModuleMappings(transaction, record.id);
    for (const { signal, tag } of resolved) {
      await assertTagFree(transaction, record, tag.id);
      await processModuleRepository.createMapping(transaction, {
        moduleId: record.id,
        signalId: signal.id,
        plcId: tag.plcInstanceId,
        tagId: tag.id,
      });
    }
  });
  return getModuleIoRegistry(db, actor, record.id);
}
