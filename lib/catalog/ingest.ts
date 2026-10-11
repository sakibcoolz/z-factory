/**
 * Writes catalog definitions to the database. Idempotent: every row is matched by its
 * natural key and updated in place, so ids referenced by factory data stay stable.
 * Rows that are no longer defined are left alone; removing a catalog fact is a
 * deliberate change, not a side effect of seeding.
 *
 * Used by `prisma/seed.ts` (plain Node), so this module must not import `server-only`.
 */
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import {
  type Catalog,
  type CatalogChannelGroup,
  type CatalogModel,
  type CatalogModule,
  isSimulated,
} from "@/lib/catalog/schema";
import { findBehaviorProfile } from "@/lib/domain/behavior-contract";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";

type Tx = Prisma.TransactionClient;
type Verification = CatalogModel["verification"];

export type IngestResult = {
  categories: number;
  manufacturers: number;
  models: number;
  racks: number;
  modules: number;
};

const day = (date: string) => new Date(`${date}T00:00:00.000Z`);

/** Provenance columns shared by device models and module models. */
function provenance(verification: Verification) {
  const source = verification.status === "GENERIC" ? undefined : verification.source;
  return {
    verificationStatus: verification.status,
    sourceUrl: source?.url ?? null,
    sourceTitle: source?.title ?? null,
    sourceRevision: source?.revision ?? null,
    sourceRetrievedAt: source ? day(source.retrievedAt) : null,
    verifiedAt: verification.status === "VERIFIED" ? day(verification.verifiedAt) : null,
  };
}

/** One row per channel; indexes continue across the groups of the same point type. */
function expandChannels(groups: readonly CatalogChannelGroup[]) {
  const next = new Map<string, number>();
  return groups.flatMap((group) =>
    Array.from({ length: group.count }, (_, offset) => {
      const channelIndex = next.get(group.ioType) ?? 0;
      next.set(group.ioType, channelIndex + 1);
      return {
        ioType: group.ioType,
        channelIndex,
        signalType: group.signalType,
        acceptedSignalTypes: group.acceptedSignalTypes,
        terminalLabel: group.terminalLabels?.[offset] ?? null,
        addressHint: group.addressHints?.[offset] ?? null,
        electricalLimitsJson: group.limits,
      };
    }),
  );
}

async function upsertFamily(tx: Tx, manufacturerId: string, deviceCategoryId: string, name: string) {
  return tx.deviceFamily.upsert({
    where: { manufacturerId_name: { manufacturerId, name } },
    create: { manufacturerId, deviceCategoryId, name },
    update: { deviceCategoryId },
  });
}

async function ingestModel(tx: Tx, model: CatalogModel, familyId: string): Promise<string> {
  const data = {
    sku: model.sku ?? null,
    architectureType: model.architectureType ?? null,
    runtimeSupport: model.runtimeSupport,
    controlCapability: model.controlCapability,
    capabilities: model.capabilities,
    lifecycleStatus: model.lifecycleStatus,
    metadataJson: model.facts,
    // The simulation decision (TASK-1010): coverage, profile, and the declared block as recorded.
    simulationCoverage: model.simulation.coverage,
    simulationProfile: isSimulated(model) ? model.simulation.profile : null,
    simulationProfileVersion: isSimulated(model) ? model.simulation.profileVersion : null,
    simulationJson: model.simulation as Prisma.InputJsonValue,
    ...provenance(model.verification),
  };
  const { id: deviceModelId } = await tx.deviceModel.upsert({
    where: { familyId_modelName: { familyId, modelName: model.modelName } },
    create: { familyId, modelName: model.modelName, ...data },
    update: data,
  });

  if (model.electrical) {
    const electrical = {
      supplyType: model.electrical.supplyType,
      nominalVoltage: model.electrical.nominalVoltage ?? null,
      voltageMin: model.electrical.voltageMin ?? null,
      voltageMax: model.electrical.voltageMax ?? null,
      notes: model.electrical.notes ?? null,
    };
    await tx.electricalProfile.upsert({
      where: { deviceModelId },
      create: { deviceModelId, ...electrical },
      update: electrical,
    });
  }
  for (const port of model.ports) {
    const values = {
      physicalType: port.physicalType,
      protocols: port.protocols,
      portCount: port.portCount,
      maxConnections: port.maxConnections,
      notes: port.notes ?? null,
    };
    await tx.communicationPort.upsert({
      where: { deviceModelId_name: { deviceModelId, name: port.name } },
      create: { deviceModelId, name: port.name, ...values },
      update: values,
    });
  }
  for (const { ioType, channelIndex, addressHint, ...values } of expandChannels(model.builtInChannels)) {
    await tx.builtInIoChannel.upsert({
      where: { deviceModelId_ioType_channelIndex: { deviceModelId, ioType, channelIndex } },
      create: { deviceModelId, ioType, channelIndex, addressHint, ...values },
      update: { addressHint, ...values },
    });
  }
  // Terminals have no database key of their own; the label is unique within a model.
  for (const terminal of model.terminals) {
    const values = {
      kind: terminal.kind,
      maxConnections: terminal.maxConnections,
      // Direction and class are not meaningful for every kind; the columns are filled all the same.
      direction: terminal.direction ?? "INPUT",
      ioType: terminal.ioType ?? "DIGITAL",
      signalType: terminal.signalType ?? "",
      rangeMin: terminal.rangeMin ?? null,
      rangeMax: terminal.rangeMax ?? null,
      unit: terminal.unit ?? null,
      simulatorSignal: terminal.simulatorSignal ?? null,
      notes: terminal.notes ?? null,
    };
    const existing = await tx.deviceIoDefinition.findFirst({
      where: { deviceModelId, terminalLabel: terminal.terminalLabel },
    });
    if (existing) await tx.deviceIoDefinition.update({ where: { id: existing.id }, data: values });
    else
      await tx.deviceIoDefinition.create({ data: { deviceModelId, terminalLabel: terminal.terminalLabel, ...values } });
  }
  if (!isSimulated(model)) return deviceModelId;
  // Faults and parameter values are those of the model's behaviour profile; the catalog
  // rules have already checked they exist there.
  const profile = findBehaviorProfile(model.simulation.profile);
  if (!profile)
    throw new Error(`Catalog model ${model.modelName} names an unknown profile ${model.simulation.profile}.`);
  for (const code of model.simulation.faults) {
    const fault = profile.faults.find((candidate) => candidate.code === code);
    if (!fault) throw new Error(`Catalog model ${model.modelName} lists an unsupported fault ${code}.`);
    const values = {
      name: fault.name,
      severity: fault.severity,
      resetBehavior: fault.latching ? ("MANUAL" as const) : ("AUTO" as const),
    };
    await tx.deviceFaultDefinition.upsert({
      where: { deviceModelId_code: { deviceModelId, code } },
      create: { deviceModelId, code, ...values },
      update: values,
    });
  }
  // Parameter values become the model-level simulation profile the simulator reads for
  // every instance without one of its own (docs/device-simulation.md → Parameters).
  if (Object.keys(model.simulation.parameters).length > 0) {
    const parametersJson = model.simulation.parameters as Prisma.InputJsonValue;
    const existing = await tx.simulationProfile.findFirst({ where: { deviceModelId } });
    if (existing) await tx.simulationProfile.update({ where: { id: existing.id }, data: { parametersJson } });
    else await tx.simulationProfile.create({ data: { deviceModelId, kind: "STATE_MACHINE", parametersJson } });
  }
  return deviceModelId;
}

async function ingestModule(tx: Tx, definition: CatalogModule, familyId: string, cpuIds: ReadonlyMap<string, string>) {
  const data = {
    sku: definition.sku,
    moduleType: definition.moduleType,
    metadataJson: definition.facts,
    ...provenance(definition.verification),
  };
  const { id: moduleModelId } = await tx.moduleModel.upsert({
    where: { familyId_modelName: { familyId, modelName: definition.modelName } },
    create: { familyId, modelName: definition.modelName, ...data },
    update: data,
  });
  for (const { ioType, channelIndex, addressHint: _addressHint, ...values } of expandChannels(definition.channels)) {
    await tx.moduleChannel.upsert({
      where: { moduleModelId_ioType_channelIndex: { moduleModelId, ioType, channelIndex } },
      create: { moduleModelId, ioType, channelIndex, ...values },
      update: values,
    });
  }
  for (const cpu of definition.compatibleCpus) {
    const cpuModelId = cpuIds.get(`${familyId}/${cpu}`);
    if (!cpuModelId) throw new Error(`Catalog module ${definition.modelName} names an unknown CPU ${cpu}.`);
    const notes = definition.compatibilityNotes ?? null;
    await tx.moduleCompatibility.upsert({
      where: { moduleModelId_cpuModelId: { moduleModelId, cpuModelId } },
      create: { moduleModelId, cpuModelId, notes },
      update: { notes },
    });
  }
}

/** Seeds the generic categories and writes a validated catalog. Safe to run repeatedly. */
export async function ingestCatalog(db: PrismaClient, catalog: Catalog): Promise<IngestResult> {
  return db.$transaction(
    async (tx) => {
      const categoryIds = new Map<string, string>();
      for (const { code, ...values } of GENERIC_CATEGORIES) {
        const row = await tx.deviceCategory.upsert({ where: { code }, create: { code, ...values }, update: values });
        categoryIds.set(code, row.id);
      }
      const manufacturerIds = new Map<string, string>();
      for (const manufacturer of catalog.manufacturers) {
        const websiteUrl = manufacturer.websiteUrl ?? null;
        const row = await tx.manufacturer.upsert({
          where: { name: manufacturer.name },
          create: { name: manufacturer.name, websiteUrl },
          update: { websiteUrl },
        });
        manufacturerIds.set(manufacturer.name, row.id);
      }

      const familyIds = new Map<string, string>();
      const cpuIds = new Map<string, string>();
      for (const model of catalog.models) {
        const manufacturerId = manufacturerIds.get(model.manufacturer);
        const categoryId = categoryIds.get(model.category);
        if (!manufacturerId || !categoryId) throw new Error(`Catalog model ${model.modelName} is not resolvable.`);
        const family = await upsertFamily(tx, manufacturerId, categoryId, model.family);
        familyIds.set(`${model.manufacturer}/${model.family}`, family.id);
        cpuIds.set(`${family.id}/${model.modelName}`, await ingestModel(tx, model, family.id));
      }
      for (const rack of catalog.racks) {
        const familyId = familyIds.get(`${rack.manufacturer}/${rack.family}`);
        if (!familyId) throw new Error(`Catalog rack ${rack.name} names an unknown family.`);
        const values = { slotCount: rack.slotCount, notes: rack.notes ?? null };
        await tx.rackProfile.upsert({
          where: { familyId_name: { familyId, name: rack.name } },
          create: { familyId, name: rack.name, ...values },
          update: values,
        });
      }
      for (const definition of catalog.modules) {
        const familyId = familyIds.get(`${definition.manufacturer}/${definition.family}`);
        if (!familyId) throw new Error(`Catalog module ${definition.modelName} names an unknown family.`);
        await ingestModule(tx, definition, familyId, cpuIds);
      }
      return {
        categories: GENERIC_CATEGORIES.length,
        manufacturers: catalog.manufacturers.length,
        models: catalog.models.length,
        racks: catalog.racks.length,
        modules: catalog.modules.length,
      };
    },
    { timeout: 60_000 },
  );
}
