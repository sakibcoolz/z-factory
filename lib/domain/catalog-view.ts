/**
 * Shapes the catalog service returns and the catalog screens render
 * (docs/device-catalog.md). Pure types; importable anywhere.
 */
import type { ControlCapability, VerificationStatus } from "@/lib/domain/catalog";
import type { IoDirection, IoPointType, IoSignalClass, PlcArchitecture } from "@/lib/domain/device";

/** A terminal of a peripheral, seen from the device. */
export type CatalogTerminal = {
  terminalLabel: string | null;
  direction: IoDirection;
  ioType: IoSignalClass;
  signalType: string;
  /** Signal of the simulator behaviour model the terminal carries, when it has one. */
  simulatorSignal: string | null;
};

export type CatalogModelSummary = {
  id: string;
  modelName: string;
  sku: string | null;
  architectureType: PlcArchitecture | null;
  verificationStatus: VerificationStatus;
};

export type CatalogOverview = {
  manufacturers: Array<{
    id: string;
    name: string;
    modelCount: number;
    families: Array<{
      id: string;
      name: string;
      categoryCode: string;
      categoryName: string;
      models: CatalogModelSummary[];
    }>;
  }>;
  /** Categories that have at least one model. */
  categories: Array<{ code: string; name: string; modelCount: number }>;
  totals: { models: number; manufacturers: number; verified: number; generic: number };
};

/** A run of identical channels, e.g. "14 × DI, 24 V DC". */
export type ChannelSummary = {
  ioType: IoPointType;
  count: number;
  signalType: string;
  acceptedSignalTypes: string[];
};

export type CatalogModelDetail = CatalogModelSummary & {
  manufacturer: string;
  family: string;
  categoryCode: string;
  categoryName: string;
  runtimeSupport: string;
  controlCapability: ControlCapability;
  lifecycleStatus: string;
  /** Where the facts come from. All null for generic models. */
  source: {
    url: string | null;
    title: string | null;
    revision: string | null;
    retrievedAt: string | null;
    verifiedAt: string | null;
  };
  electrical: {
    supplyType: string | null;
    nominalVoltage: number | null;
    voltageMin: number | null;
    voltageMax: number | null;
    notes: string | null;
  } | null;
  ports: Array<{ name: string; physicalType: string; protocols: string[]; portCount: number; notes: string | null }>;
  builtInChannels: ChannelSummary[];
  terminals: CatalogTerminal[];
  /** Further documented facts, as recorded. */
  facts: Record<string, unknown>;
  racks: Array<{ name: string; slotCount: number; notes: string | null }>;
  /** Modules that can be installed with this CPU (modular PLCs). */
  modules: Array<{
    modelName: string;
    sku: string | null;
    moduleType: string;
    verificationStatus: VerificationStatus;
    channels: ChannelSummary[];
    notes: string | null;
  }>;
};

export type PeripheralCompatibility = {
  modelId: string;
  manufacturer: string;
  modelName: string;
  categoryCode: string;
  categoryName: string;
  verificationStatus: VerificationStatus;
  controlCapability: ControlCapability;
  /** Hardwired connection: each terminal with the PLC point class it needs. Null when the device has no terminals. */
  directIo: null | {
    compatible: boolean;
    terminals: Array<{
      terminalLabel: string | null;
      required: IoPointType;
      signalType: string;
      satisfied: boolean;
      modules: string[];
    }>;
  };
  /** Protocols both the PLC and the device have a port for. */
  protocols: string[];
  compatible: boolean;
};
