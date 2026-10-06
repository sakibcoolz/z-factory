import "server-only";
import { catalogRepository, type CatalogModelRecord } from "@/lib/db/repositories/catalog-repository";
import {
  type CatalogModelDetail,
  type CatalogTerminal,
  type CatalogOverview,
  type ChannelSummary,
  type PeripheralCompatibility,
  summarizeAssetVersions,
} from "@/lib/domain/catalog-view";
import { isProgrammableController } from "@/lib/domain/device-capabilities";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { placeholderFor } from "@/lib/scene/placeholders";
import {
  matchTerminals,
  matchTerminalsToModules,
  type PlcChannel,
  sharedProtocols,
} from "@/lib/validation/compatibility";

/**
 * Read access to the device catalog: reusable models with their provenance, and which
 * peripherals a PLC model can take. The catalog is shared reference data, not owned by
 * a factory; factory-specific device instances are created from it elsewhere.
 */

function summarize(channels: ReadonlyArray<PlcChannel & { acceptedSignalTypes: string[] }>): ChannelSummary[] {
  const groups = new Map<string, ChannelSummary>();
  for (const channel of channels) {
    const key = `${channel.ioType}|${channel.signalType}|${channel.acceptedSignalTypes.join(",")}`;
    const group = groups.get(key);
    if (group) group.count += 1;
    else {
      groups.set(key, {
        ioType: channel.ioType,
        count: 1,
        signalType: channel.signalType,
        acceptedSignalTypes: channel.acceptedSignalTypes,
      });
    }
  }
  return [...groups.values()];
}

const dateOnly = (value: Date | null) => (value ? value.toISOString().slice(0, 10) : null);

export async function getCatalogOverview(db: PrismaClient): Promise<CatalogOverview> {
  const rows = await catalogRepository.listManufacturers(db);
  const categories = new Map<string, { code: string; name: string; modelCount: number }>();
  let verified = 0;
  let generic = 0;
  let withAsset = 0;
  const manufacturers = rows
    .map((manufacturer) => {
      const families = manufacturer.families
        .filter((family) => family.models.length > 0)
        .map((family) => {
          const category = categories.get(family.category.code) ?? {
            code: family.category.code,
            name: family.category.name,
            modelCount: 0,
          };
          category.modelCount += family.models.length;
          categories.set(category.code, category);
          const models = family.models.map(({ active3dAssetId, assets3d, ...model }) => {
            if (model.verificationStatus === "VERIFIED") verified += 1;
            if (model.verificationStatus === "GENERIC") generic += 1;
            const asset = summarizeAssetVersions(
              assets3d.map((version) => ({ ...version, active: version.id === active3dAssetId })),
            );
            if (asset.activeVersion !== null) withAsset += 1;
            return { ...model, asset };
          });
          return {
            id: family.id,
            name: family.name,
            categoryCode: family.category.code,
            categoryName: family.category.name,
            models,
          };
        });
      return {
        id: manufacturer.id,
        name: manufacturer.name,
        modelCount: families.reduce((count, family) => count + family.models.length, 0),
        families,
      };
    })
    .filter((manufacturer) => manufacturer.modelCount > 0);
  return {
    manufacturers,
    categories: [...categories.values()].sort((a, b) => a.name.localeCompare(b.name)),
    totals: {
      models: manufacturers.reduce((count, manufacturer) => count + manufacturer.modelCount, 0),
      manufacturers: manufacturers.length,
      verified,
      generic,
      withAsset,
    },
  };
}

async function loadModel(db: PrismaClient, modelId: string): Promise<CatalogModelRecord> {
  const model = await catalogRepository.findModel(db, modelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  return model;
}

function toTerminals(model: { ioDefinitions: CatalogModelRecord["ioDefinitions"] }): CatalogTerminal[] {
  return model.ioDefinitions.map((terminal) => ({
    terminalLabel: terminal.terminalLabel,
    kind: terminal.kind,
    maxConnections: terminal.maxConnections,
    // The columns are filled for every kind; only what the kind has is shown.
    direction: terminal.kind === "SIGNAL" || terminal.kind === "POWER" ? terminal.direction : null,
    ioType: terminal.kind === "SIGNAL" ? terminal.ioType : null,
    signalType: terminal.signalType || null,
    simulatorSignal: terminal.simulatorSignal,
  }));
}

export async function getCatalogModel(db: PrismaClient, modelId: string): Promise<CatalogModelDetail> {
  const model = await loadModel(db, modelId);
  const isPlc = isProgrammableController(model);
  const assetVersions = model.assets3d.map((asset) => ({
    id: asset.id,
    version: asset.version,
    status: asset.status,
    active: asset.id === model.active3dAssetId,
    provider: asset.provider,
    providerJobId: asset.providerJobId,
    providerStatus: asset.providerStatus,
    statusMessage: asset.statusMessage,
    sizeBytes: asset.sizeBytes,
    updatedAt: asset.updatedAt.toISOString().slice(0, 10),
  }));
  return {
    id: model.id,
    modelName: model.modelName,
    sku: model.sku,
    architectureType: model.architectureType,
    verificationStatus: model.verificationStatus,
    asset: summarizeAssetVersions(assetVersions),
    assetVersions,
    placeholderKind: placeholderFor(model.family.category.code).kind,
    manufacturer: model.family.manufacturer.name,
    family: model.family.name,
    categoryCode: model.family.category.code,
    categoryName: model.family.category.name,
    runtimeSupport: model.runtimeSupport,
    controlCapability: model.controlCapability,
    lifecycleStatus: model.lifecycleStatus,
    source: {
      url: model.sourceUrl,
      title: model.sourceTitle,
      revision: model.sourceRevision,
      retrievedAt: dateOnly(model.sourceRetrievedAt),
      verifiedAt: dateOnly(model.verifiedAt),
    },
    electrical: model.electricalProfile
      ? {
          supplyType: model.electricalProfile.supplyType,
          nominalVoltage: model.electricalProfile.nominalVoltage,
          voltageMin: model.electricalProfile.voltageMin,
          voltageMax: model.electricalProfile.voltageMax,
          notes: model.electricalProfile.notes,
        }
      : null,
    ports: model.communicationPorts.map((port) => ({
      name: port.name,
      physicalType: port.physicalType,
      protocols: port.protocols,
      portCount: port.portCount,
      notes: port.notes,
    })),
    builtInChannels: summarize(model.builtInIoChannels),
    terminals: toTerminals(model),
    facts: (model.metadataJson ?? {}) as Record<string, unknown>,
    racks:
      isPlc && model.architectureType === "MODULAR"
        ? model.family.rackProfiles.map((rack) => ({ name: rack.name, slotCount: rack.slotCount, notes: rack.notes }))
        : [],
    modules: model.moduleCompatibility
      .map((entry) => ({
        modelName: entry.moduleModel.modelName,
        sku: entry.moduleModel.sku,
        moduleType: entry.moduleModel.moduleType,
        verificationStatus: entry.moduleModel.verificationStatus,
        channels: summarize(entry.moduleModel.channels),
        notes: entry.notes,
      }))
      .sort((a, b) => a.modelName.localeCompare(b.modelName)),
  };
}

/**
 * Which peripheral models a PLC model can take, and how: hardwired to its channels
 * (built-in for a compact PLC, through installable modules for a modular one) or over a
 * protocol both have a port for. Occupancy of a particular PLC instance is checked when
 * a device is actually wired.
 */
export async function listCompatiblePeripherals(
  db: PrismaClient,
  plcModelId: string,
  options: { compatibleOnly?: boolean } = {},
): Promise<PeripheralCompatibility[]> {
  const plc = await loadModel(db, plcModelId);
  if (!isProgrammableController(plc)) {
    throw new DomainError("INCOMPATIBLE", "Peripheral compatibility is evaluated for a PLC model.", {
      rule: "plc-model",
    });
  }
  const modular = plc.architectureType === "MODULAR";
  const modules = plc.moduleCompatibility.map((entry) => ({
    modelName: entry.moduleModel.modelName,
    channels: entry.moduleModel.channels,
  }));

  const result = (await catalogRepository.listPeripherals(db)).map((peripheral): PeripheralCompatibility => {
    // Signal terminals only: these are what a PLC channel is needed for.
    const terminals = peripheral.ioDefinitions.map(({ terminalLabel, direction, ioType, signalType }) => ({
      terminalLabel,
      direction,
      ioType,
      signalType,
    }));
    let directIo: PeripheralCompatibility["directIo"] = null;
    if (terminals.length > 0) {
      if (modular) directIo = matchTerminalsToModules(terminals, modules);
      else {
        const match = matchTerminals(terminals, plc.builtInIoChannels);
        directIo = {
          compatible: match.compatible,
          terminals: match.terminals.map((terminal) => ({ ...terminal, modules: [] })),
        };
      }
    }
    const protocols = sharedProtocols(plc.communicationPorts, peripheral.communicationPorts);
    return {
      modelId: peripheral.id,
      manufacturer: peripheral.family.manufacturer.name,
      modelName: peripheral.modelName,
      categoryCode: peripheral.family.category.code,
      categoryName: peripheral.family.category.name,
      verificationStatus: peripheral.verificationStatus,
      controlCapability: peripheral.controlCapability,
      directIo,
      protocols,
      compatible: directIo?.compatible === true || protocols.length > 0,
    };
  });
  return options.compatibleOnly ? result.filter((entry) => entry.compatible) : result;
}
