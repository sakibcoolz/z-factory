import "server-only";
import { catalogRepository, type CatalogModelRecord } from "@/lib/db/repositories/catalog-repository";
import type {
  CatalogModelDetail,
  CatalogTerminal,
  CatalogOverview,
  ChannelSummary,
  PeripheralCompatibility,
} from "@/lib/domain/catalog-view";
import { PLC_CATEGORY_CODE } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
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
          for (const model of family.models) {
            if (model.verificationStatus === "VERIFIED") verified += 1;
            if (model.verificationStatus === "GENERIC") generic += 1;
          }
          return {
            id: family.id,
            name: family.name,
            categoryCode: family.category.code,
            categoryName: family.category.name,
            models: family.models,
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
    direction: terminal.direction,
    ioType: terminal.ioType,
    signalType: terminal.signalType,
    simulatorSignal: terminal.simulatorSignal,
  }));
}

export async function getCatalogModel(db: PrismaClient, modelId: string): Promise<CatalogModelDetail> {
  const model = await loadModel(db, modelId);
  const isPlc = model.family.category.code === PLC_CATEGORY_CODE;
  return {
    id: model.id,
    modelName: model.modelName,
    sku: model.sku,
    architectureType: model.architectureType,
    verificationStatus: model.verificationStatus,
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
  if (plc.family.category.code !== PLC_CATEGORY_CODE) {
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
    const terminals = toTerminals(peripheral);
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
