/**
 * Shapes the catalog service returns and the catalog screens render
 * (docs/device-catalog.md). Types and pure rules; importable anywhere.
 */
import { coverageStatement, type SimulationCoverage } from "@/lib/domain/behavior-contract";
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

/**
 * The simulation decision of a model (TASK-1010), as the catalog shows it: a statement
 * about a behaviour model, never about vendor firmware.
 */
export type CatalogSimulation = {
  coverage: SimulationCoverage;
  /** The behaviour profile the model runs on; null when nothing executes it. */
  profile: { key: string; version: number } | null;
  /** Why nothing executes a NOT_SIMULATABLE model. */
  reason: string | null;
  /** Fault codes of the profile the model supports. */
  faults: string[];
  /** Parameter values the model sets; the profile's generic defaults otherwise. */
  parameters: Record<string, number | string>;
  /** Model-specific behaviours declared for a vendor model, and whether each is implemented. */
  features: Array<{ key: string; label: string; implemented: boolean }>;
  /**
   * Where every model-specific fact of a vendor model was read (TASK-1012), by fact
   * (`parameter:maxFrequencyHz`, `feature:S_RAMP`, `fault:OVERCURRENT`). Empty for a
   * generic model: it states no vendor fact.
   */
  sources: Record<string, CatalogFactSourceView>;
  /** The protocol the model is served over and its declared register map (TASK-1013); null when hardwired. */
  protocol: { kind: string; registerMap: { key: string; version: number } } | null;
  /** For a NOT_SIMULATABLE model, the profile the runtime runs for it (TASK-1015 switches it over). */
  runtimeOnly: { profile: { key: string; version: number } } | null;
  /** The sentence to show for the coverage. */
  statement: string;
};

/** One register of a protocol-controlled model, as stored from its declared map. */
export type CatalogRegister = {
  protocol: string;
  area: string;
  address: number;
  dataType: string;
  wordCount: number;
  access: string;
  scale: number;
  unit: string | null;
  semanticRole: string | null;
};

/** One fact's source as the catalog shows it: the place in a named manufacturer document. */
export type CatalogFactSourceView = {
  reference: string;
  /** The approximation in the mapping, when the vendor's meaning is not the profile's exactly. */
  note: string | null;
  document: { url: string; title: string; revision: string; retrievedAt: string } | null;
};

/** The source of a fact of a kind, or null when the model gives none (a generic model). */
export function factSourceOf(
  simulation: Pick<CatalogSimulation, "sources">,
  kind: "parameter" | "feature" | "fault",
  key: string,
): CatalogFactSourceView | null {
  return simulation.sources[`${kind}:${key}`] ?? null;
}

/** `P044 [Maximum Freq], default 60.00 Hz, page 87 (PowerFlex 520-series User Manual)` */
export function factSourceText(source: CatalogFactSourceView): string {
  return source.document ? `${source.reference} (${source.document.title})` : source.reference;
}

type StoredSimulation = {
  simulationCoverage: SimulationCoverage;
  simulationProfile: string | null;
  simulationProfileVersion: number | null;
  simulationJson: unknown;
};

const stringList = (value: unknown): string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The stored fact sources, each resolved by the import to its document. */
function factSources(value: unknown): Record<string, CatalogFactSourceView> {
  if (!isRecord(value)) return {};
  const sources: Record<string, CatalogFactSourceView> = {};
  for (const [fact, raw] of Object.entries(value)) {
    if (!isRecord(raw) || typeof raw.reference !== "string") continue;
    const doc = isRecord(raw.document) ? raw.document : null;
    sources[fact] = {
      reference: raw.reference,
      note: typeof raw.note === "string" ? raw.note : null,
      document:
        doc && typeof doc.url === "string" && typeof doc.title === "string"
          ? {
              url: doc.url,
              title: doc.title,
              revision: typeof doc.revision === "string" ? doc.revision : "",
              retrievedAt: typeof doc.retrievedAt === "string" ? doc.retrievedAt : "",
            }
          : null,
    };
  }
  return sources;
}

/** The simulation decision of a stored model, from its columns and the declared block. */
export function summarizeSimulation(row: StoredSimulation): CatalogSimulation {
  const block = (row.simulationJson ?? {}) as Record<string, unknown>;
  const profile =
    row.simulationProfile && row.simulationProfileVersion
      ? { key: row.simulationProfile, version: row.simulationProfileVersion }
      : null;
  const parameters = Object.fromEntries(
    Object.entries((block.parameters as Record<string, unknown> | undefined) ?? {}).filter(
      (entry): entry is [string, number | string] => typeof entry[1] === "number" || typeof entry[1] === "string",
    ),
  );
  const features = Array.isArray(block.features)
    ? (block.features as Array<Record<string, unknown>>).map((feature) => ({
        key: String(feature.key),
        label: String(feature.label),
        implemented: feature.implemented === true,
      }))
    : [];
  const runtimeOnly = isRecord(block.runtimeOnly) ? block.runtimeOnly : null;
  const declaredProtocol = isRecord(block.protocol)
    ? block.protocol
    : isRecord(runtimeOnly?.protocol)
      ? runtimeOnly.protocol
      : null;
  return {
    coverage: row.simulationCoverage,
    profile,
    reason: typeof block.reason === "string" ? block.reason : null,
    faults: stringList(block.faults),
    parameters,
    features,
    sources: factSources(block.sources),
    protocol:
      declaredProtocol && typeof declaredProtocol.kind === "string" && typeof declaredProtocol.registerMap === "string"
        ? {
            kind: declaredProtocol.kind,
            registerMap: {
              key: declaredProtocol.registerMap,
              version:
                typeof declaredProtocol.registerMapVersion === "number" ? declaredProtocol.registerMapVersion : 1,
            },
          }
        : null,
    runtimeOnly:
      runtimeOnly && typeof runtimeOnly.profile === "string"
        ? {
            profile: {
              key: runtimeOnly.profile,
              version: typeof runtimeOnly.profileVersion === "number" ? runtimeOnly.profileVersion : 1,
            },
          }
        : null,
    statement: coverageStatement(row.simulationCoverage, profile),
  };
}

export type CatalogModelSummary = {
  id: string;
  modelName: string;
  sku: string | null;
  architectureType: PlcArchitecture | null;
  verificationStatus: VerificationStatus;
  /** How much of the model's behaviour the simulator implements. */
  coverage: SimulationCoverage;
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
  totals: {
    models: number;
    manufacturers: number;
    verified: number;
    generic: number;
    withAsset: number;
    /** Models the simulator executes: coverage other than NOT_SIMULATABLE. */
    simulated: number;
  };
};

/** A run of identical channels, e.g. "14 × DI, 24 V DC". */
export type ChannelSummary = {
  ioType: IoPointType;
  count: number;
  signalType: string;
  acceptedSignalTypes: string[];
};

export type CatalogModelDetail = Omit<CatalogModelSummary, "coverage"> & {
  manufacturer: string;
  family: string;
  categoryCode: string;
  categoryName: string;
  runtimeSupport: string;
  controlCapability: ControlCapability;
  lifecycleStatus: string;
  simulation: CatalogSimulation;
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
  /** The declared register map of a protocol-controlled model, as stored (TASK-1013). */
  registers: CatalogRegister[];
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
