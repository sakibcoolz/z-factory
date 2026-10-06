/**
 * Shapes the catalog service returns and the catalog screens render
 * (docs/device-catalog.md). Types and pure rules; importable anywhere.
 */
import type { ControlCapability, VerificationStatus } from "@/lib/domain/catalog";
import type { IoDirection, IoPointType, IoSignalClass, PlcArchitecture, TerminalKind } from "@/lib/domain/device";

/** A terminal of a peripheral, seen from the device. */
export type CatalogTerminal = {
  terminalLabel: string | null;
  /** A signal, or a supply, 0 V or earth terminal. */
  kind: TerminalKind;
  /** How many wires the terminal takes. */
  maxConnections: number;
  /** For a signal or supply terminal; null for 0 V and earth. */
  direction: IoDirection | null;
  /** For a signal terminal only. */
  ioType: IoSignalClass | null;
  /** The signal standard or supply voltage; null for 0 V and earth. */
  signalType: string | null;
  /** Signal of the simulator behaviour model the terminal carries, when it has one. */
  simulatorSignal: string | null;
};

/** One stored version of a catalog model's 3D asset, as the catalog shows it. */
export type CatalogAssetVersion = {
  id: string;
  version: number;
  status: "PENDING" | "READY" | "FAILED" | "RETIRED";
  /** The version every factory instance of the model is drawn from. */
  active: boolean;
  provider: string;
  providerJobId: string | null;
  providerStatus: string | null;
  /** Why the version is pending, failed or retired. */
  statusMessage: string | null;
  sizeBytes: number | null;
  /** Date of the last change, `YYYY-MM-DD`. */
  updatedAt: string;
};

/**
 * Where the 3D asset of a catalog model stands. `NONE` and `FAILED` without an active
 * version mean the model is drawn as the generic shape of its category.
 */
export type CatalogAssetSummary = {
  state: "READY" | "PENDING" | "FAILED" | "NONE";
  /** The version that is rendered; null while the generic shape is. */
  activeVersion: number | null;
};

/**
 * The state of a model's asset from its versions (newest first): a job that is running
 * or has failed since the rendered version is what an author needs to see first.
 */
export function summarizeAssetVersions(
  versions: ReadonlyArray<Pick<CatalogAssetVersion, "version" | "status" | "active">>,
): CatalogAssetSummary {
  const active = versions.find((version) => version.active && version.status === "READY");
  const newest = versions.find((version) => version.status !== "RETIRED");
  const activeVersion = active?.version ?? null;
  if (newest?.status === "PENDING") return { state: "PENDING", activeVersion };
  if (newest?.status === "FAILED" && newest.version > (activeVersion ?? 0)) return { state: "FAILED", activeVersion };
  return { state: active ? "READY" : "NONE", activeVersion };
}

export function assetSummaryLabel(asset: CatalogAssetSummary): string {
  const rendered = asset.activeVersion === null ? "generic shape" : `3D v${asset.activeVersion}`;
  if (asset.state === "PENDING") return `${rendered} · generating`;
  if (asset.state === "FAILED") return `${rendered} · generation failed`;
  return rendered;
}

export type CatalogModelSummary = {
  id: string;
  modelName: string;
  sku: string | null;
  architectureType: PlcArchitecture | null;
  verificationStatus: VerificationStatus;
  asset: CatalogAssetSummary;
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
  totals: { models: number; manufacturers: number; verified: number; generic: number; withAsset: number };
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
  /** Every stored version of the model's 3D asset, newest first. */
  assetVersions: CatalogAssetVersion[];
  /** The generic shape the model is drawn as without an asset, e.g. `cabinet`. */
  placeholderKind: string;
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
