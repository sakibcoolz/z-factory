/**
 * Shape and rules of catalog definitions (docs/device-catalog.md, docs/references/plc-source-policy.md).
 *
 * A definition is data in this repository. `parseCatalog` checks it before anything is
 * written to the database, so an incomplete provenance record or an inconsistent
 * reference fails loudly instead of becoming a catalog fact.
 */
import { z } from "zod";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { CONTROL_CAPABILITIES, SIGNAL_TYPES } from "@/lib/domain/catalog";
import { CONTROLLER_CATEGORY_CODES, DEVICE_CAPABILITIES } from "@/lib/domain/device-capabilities";
import {
  IO_DIRECTIONS,
  IO_POINT_TYPES,
  IO_SIGNAL_CLASSES,
  PLC_CATEGORY_CODE,
  TERMINAL_KINDS,
} from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";
import { type BehaviorProfile, checkParameterValue, findBehaviorProfile } from "@/lib/domain/behavior-contract";

const text = z.string().trim().min(1).max(200);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");
const signalType = z.enum(SIGNAL_TYPES);
const jsonValue = z.union([z.string(), z.number(), z.boolean(), z.array(z.string()), z.array(z.number())]);

/** Where a fact comes from. Manuals are referenced, never copied into the repository. */
const sourceSchema = z.strictObject({
  url: z.url(),
  title: text,
  /** Document number, edition and date as printed in the document. */
  revision: text,
  retrievedAt: isoDate,
});

const verificationSchema = z.discriminatedUnion("status", [
  /** Checked against the manufacturer's documentation named in `source`. */
  z.strictObject({ status: z.literal("VERIFIED"), source: sourceSchema, verifiedAt: isoDate }),
  /** A vendor record whose facts have not been checked yet. */
  z.strictObject({ status: z.literal("UNVERIFIED"), source: sourceSchema.optional() }),
  /** A simulated profile that makes no vendor claim. */
  z.strictObject({ status: z.literal("GENERIC") }),
]);

/** A run of identical PLC channels. Labels and address hints are given only where documented. */
const channelGroupSchema = z
  .strictObject({
    ioType: z.enum(IO_POINT_TYPES),
    count: z.number().int().min(1).max(64),
    signalType,
    acceptedSignalTypes: z.array(signalType).default([]),
    terminalLabels: z.array(text).optional(),
    addressHints: z.array(text).optional(),
    limits: z.record(z.string(), jsonValue).default({}),
  })
  .refine((group) => (group.terminalLabels?.length ?? 0) <= group.count, "more terminal labels than channels")
  .refine((group) => (group.addressHints?.length ?? 0) <= group.count, "more address hints than channels");

const electricalSchema = z.strictObject({
  supplyType: z.enum(["AC", "DC", "AC_DC"]),
  nominalVoltage: z.number().positive().optional(),
  voltageMin: z.number().nonnegative().optional(),
  voltageMax: z.number().positive().optional(),
  notes: text.optional(),
});

const portSchema = z.strictObject({
  name: text,
  physicalType: text,
  protocols: z.array(z.enum(["MODBUS_TCP"])).default([]),
  portCount: z.number().int().min(1).max(16).default(1),
  /** How many links Z-Factory allows on the port; a bus endpoint is shared within this limit. */
  maxConnections: z.number().int().min(1).max(64).default(16),
  notes: text.optional(),
});

/**
 * A terminal of a device, seen from the device. A SIGNAL terminal carries one process
 * signal and may be tied to a simulator signal. POWER, COMMON and EARTH terminals are
 * supply, 0 V and protective earth; they take more than one wire only where
 * `maxConnections` says so.
 */
const terminalSchema = z
  .strictObject({
    terminalLabel: text,
    kind: z.enum(TERMINAL_KINDS).default("SIGNAL"),
    /** SIGNAL: the device drives (OUTPUT) or reads (INPUT) it. POWER: it supplies (OUTPUT) or takes (INPUT). */
    direction: z.enum(IO_DIRECTIONS).optional(),
    ioType: z.enum(IO_SIGNAL_CLASSES).optional(),
    /** The signal standard, or for POWER the supply voltage. */
    signalType: signalType.optional(),
    maxConnections: z.number().int().min(1).max(64).default(1),
    rangeMin: z.number().optional(),
    rangeMax: z.number().optional(),
    unit: z.string().max(16).optional(),
    /** Signal of the device's behaviour model this terminal carries (lib/domain/simulation.ts). */
    simulatorSignal: z.string().max(64).optional(),
    notes: text.optional(),
  })
  .superRefine((terminal, context) => {
    const need = (field: "direction" | "ioType" | "signalType") => {
      if (terminal[field] === undefined) {
        context.addIssue({ code: "custom", path: [field], message: `a ${terminal.kind} terminal needs ${field}` });
      }
    };
    const refuse = (field: "direction" | "ioType" | "signalType" | "simulatorSignal") => {
      if (terminal[field] !== undefined) {
        context.addIssue({ code: "custom", path: [field], message: `a ${terminal.kind} terminal has no ${field}` });
      }
    };
    if (terminal.kind === "SIGNAL") for (const field of ["direction", "ioType", "signalType"] as const) need(field);
    if (terminal.kind === "POWER") {
      need("direction");
      need("signalType");
      refuse("ioType");
    }
    if (terminal.kind === "COMMON" || terminal.kind === "EARTH") {
      for (const field of ["direction", "ioType", "signalType"] as const) refuse(field);
    }
    if (terminal.kind !== "SIGNAL") refuse("simulatorSignal");
  });

/** A behaviour of a vendor model Z-Factory declares, and whether the simulator implements it. */
const featureSchema = z.strictObject({
  key: z.string().regex(/^[A-Z][A-Z0-9_]{1,63}$/, "an UPPER_SNAKE key"),
  label: text,
  implemented: z.boolean(),
});

/**
 * Where one model-specific behaviour fact of a vendor model was read (TASK-1012): the
 * document, by the key it has in the model's `documents` (the model's own source when
 * omitted), the place in it, and how the fact maps onto the profile when that needs saying.
 */
const factSourceSchema = z.strictObject({
  document: text.optional(),
  /** Parameter, table or page as printed: `P044 [Maximum Freq], default 60.00 Hz, page 87`. */
  reference: text,
  /** The approximation in the mapping, when the profile's meaning is not the vendor's exactly. */
  note: z.string().trim().min(1).max(400).optional(),
});

/** The kinds of model-specific fact a source may be given for, and how they are keyed. */
export const FACT_KINDS = ["parameter", "feature", "fault"] as const;
export type FactKind = (typeof FACT_KINDS)[number];
export const factKey = (kind: FactKind, key: string) => `${kind}:${key}`;

const simulatedSchema = {
  /** The behaviour profile of `lib/domain/behavior-contract.ts` the model runs on, and its version. */
  profile: text,
  profileVersion: z.number().int().min(1),
  /** Fault codes of the profile this model supports. */
  faults: z.array(text).default([]),
  /** Parameter values of the profile for this model; the others keep the profile's generic defaults. */
  parameters: z.record(z.string(), z.union([z.number(), z.string()])).default({}),
  /**
   * The source of every model-specific fact, keyed `parameter:<key>`, `feature:<KEY>` or
   * `fault:<CODE>`. A vendor model names one per parameter value, declared feature and
   * supported fault; a generic model has none.
   */
  sources: z.record(z.string(), factSourceSchema).default({}),
};

/**
 * The simulation decision of a model (Phase 10, TASK-1010): exactly one coverage state.
 * Whatever the state, it is a statement about a behaviour model, never about vendor firmware.
 */
const simulationSchema = z.discriminatedUnion("coverage", [
  /** Configuration and metadata only. The reason says why nothing executes it. */
  z.strictObject({ coverage: z.literal("NOT_SIMULATABLE"), reason: text }),
  /** The generic behaviour of the category, nothing model-specific. */
  z.strictObject({ coverage: z.literal("GENERIC"), ...simulatedSchema }),
  /** A declared subset of the model's behaviour is implemented. */
  z.strictObject({ coverage: z.literal("PARTIAL"), ...simulatedSchema, features: z.array(featureSchema).min(2) }),
  /** Every declared behaviour of the model is implemented. */
  z.strictObject({ coverage: z.literal("FULL"), ...simulatedSchema, features: z.array(featureSchema).min(1) }),
]);

const modelSchema = z.strictObject({
  manufacturer: text,
  category: z.enum(GENERIC_CATEGORIES.map((category) => category.code) as [string, ...string[]]),
  family: text,
  modelName: text,
  sku: text.optional(),
  architectureType: z.enum(["COMPACT", "MODULAR"]).optional(),
  runtimeSupport: z.enum(["OPENPLC", "DEVICE_SIM", "MODBUS_SIM", "EXTERNAL", "NONE"]),
  controlCapability: z.enum(CONTROL_CAPABILITIES),
  /** What Z-Factory can do with the model: screens, checks and adapters follow these (TASK-308). */
  capabilities: z.array(z.enum(DEVICE_CAPABILITIES)).default([]),
  lifecycleStatus: z.enum(["ACTIVE", "PHASED_OUT", "DISCONTINUED", "UNKNOWN"]).default("UNKNOWN"),
  verification: verificationSchema,
  /** Further manufacturer documents of a vendor model, by key, for facts not in its verification source. */
  documents: z.record(z.string(), sourceSchema).default({}),
  electrical: electricalSchema.optional(),
  ports: z.array(portSchema).default([]),
  builtInChannels: z.array(channelGroupSchema).default([]),
  terminals: z.array(terminalSchema).default([]),
  /** What the simulator does for the model: its coverage, profile, faults and parameters, or why nothing. */
  simulation: simulationSchema,
  /** Further documented facts (memory, expansion limits, …), shown as-is. */
  facts: z.record(z.string(), jsonValue).default({}),
});

const moduleSchema = z.strictObject({
  manufacturer: text,
  family: text,
  modelName: text,
  sku: text,
  moduleType: z.enum([
    "POWER_SUPPLY",
    "DIGITAL_INPUT",
    "DIGITAL_OUTPUT",
    "DIGITAL_MIXED",
    "ANALOG_INPUT",
    "ANALOG_OUTPUT",
    "ANALOG_MIXED",
    "COMMUNICATION",
    "OTHER",
  ]),
  verification: verificationSchema,
  channels: z.array(channelGroupSchema).default([]),
  /** Model names of the CPUs (same family) this module can be installed with. */
  compatibleCpus: z.array(text).min(1),
  compatibilityNotes: text.optional(),
  facts: z.record(z.string(), jsonValue).default({}),
});

const rackSchema = z.strictObject({
  manufacturer: text,
  family: text,
  name: text,
  slotCount: z.number().int().min(1).max(64),
  notes: text.optional(),
});

const manufacturerSchema = z.strictObject({ name: text, websiteUrl: z.url().optional() });

export const catalogSchema = z.strictObject({
  manufacturers: z.array(manufacturerSchema),
  models: z.array(modelSchema),
  racks: z.array(rackSchema).default([]),
  modules: z.array(moduleSchema).default([]),
});

export type CatalogInput = z.input<typeof catalogSchema>;
export type Catalog = z.infer<typeof catalogSchema>;
export type CatalogModel = Catalog["models"][number];
export type CatalogModule = Catalog["modules"][number];
export type CatalogSimulation = CatalogModel["simulation"];
export type CatalogSource = CatalogModel["documents"][string];
export type CatalogFactSource = z.infer<typeof factSourceSchema>;
export type SimulatedCatalogModel = CatalogModel & {
  simulation: Exclude<CatalogSimulation, { coverage: "NOT_SIMULATABLE" }>;
};

/** Whether a model's simulation decision names a behaviour profile. */
export function isSimulated(model: CatalogModel): model is SimulatedCatalogModel {
  return model.simulation.coverage !== "NOT_SIMULATABLE";
}
export type CatalogChannelGroup = CatalogModel["builtInChannels"][number];

/** Name of the manufacturer that owns every generic, simulated model. */
export const GENERIC_MANUFACTURER = "Generic / simulated";

const fail = (message: string, details: Record<string, unknown>) =>
  new DomainError("VALIDATION", message, { rule: "catalog-definition", ...details });

function checkModel(model: CatalogModel, manufacturers: ReadonlySet<string>): void {
  const where = { model: `${model.manufacturer} ${model.modelName}` };
  if (!manufacturers.has(model.manufacturer)) throw fail("The model names an unknown manufacturer.", where);

  const generic = model.manufacturer === GENERIC_MANUFACTURER;
  if (generic !== (model.verification.status === "GENERIC")) {
    throw fail("Generic models, and only generic models, carry the GENERIC status.", where);
  }
  // A generic profile makes no vendor claim, so it has nothing a vendor would identify it by.
  if (generic && model.sku) throw fail("A generic model has no vendor order number.", where);
  if (!generic && !model.sku) throw fail("A vendor model needs its exact order number.", where);
  if (generic && Object.keys(model.documents).length > 0) {
    throw fail("A generic model has no manufacturer documents.", where);
  }

  // Capabilities are stated, and they agree with the other facts of the model.
  const has = (capability: (typeof DEVICE_CAPABILITIES)[number]) => model.capabilities.includes(capability);
  if (new Set(model.capabilities).size !== model.capabilities.length)
    throw fail("A capability is listed twice.", where);
  // Nothing of Z-Factory runs or ships vendor firmware: a behaviour model deploys none (TASK-1012).
  if (model.runtimeSupport === "DEVICE_SIM" && has("FIRMWARE_DEPLOYABLE")) {
    throw fail("A model the device simulator executes is a behaviour model; no firmware is deployed to it.", where);
  }
  if ((model.controlCapability === "PROGRAMMABLE") !== has("PROGRAMMABLE")) {
    throw fail("A programmable model lists the PROGRAMMABLE capability, and only such a model does.", where);
  }
  if (model.controlCapability === "PARAMETER_CONFIGURED" && !has("PARAMETER_CONFIGURABLE")) {
    throw fail("A parameter-configured model lists the PARAMETER_CONFIGURABLE capability.", where);
  }
  if (model.runtimeSupport === "OPENPLC" && !(has("PROGRAMMABLE") && has("IEC_61131_3"))) {
    throw fail("A model run by the OpenPLC adapter is programmable in an IEC 61131-3 language.", where);
  }
  if (model.ports.length === 0 && (has("MODBUS_CLIENT") || has("MODBUS_SERVER"))) {
    throw fail("A model that speaks Modbus has a communication port.", where);
  }
  // A programmable controller declares its architecture; nothing else does.
  const isPlc = model.category === PLC_CATEGORY_CODE;
  const controller = CONTROLLER_CATEGORY_CODES.includes(model.category) && has("PROGRAMMABLE");
  if (isPlc && !controller) throw fail("A PLC model is a programmable controller.", where);
  if (controller !== (model.architectureType !== undefined)) {
    throw fail("A programmable controller, and only a programmable controller, declares its architecture.", where);
  }
  if (model.architectureType === "MODULAR" && model.builtInChannels.length > 0) {
    throw fail("A modular PLC takes its I/O from modules, not built-in channels.", where);
  }
  if (!controller && model.builtInChannels.length > 0)
    throw fail("Only a controller has built-in PLC channels.", where);

  const labels = model.terminals.map((terminal) => terminal.terminalLabel);
  if (new Set(labels).size !== labels.length) throw fail("Terminal labels must be unique within a model.", where);

  checkSimulation(model, generic, where);
}

/**
 * The simulation decision of a model against the behaviour contract (TASK-1010): the
 * profile is one of its category, the runtime agrees with the coverage, the faults,
 * parameters and terminal signals are the profile's, model-specific facts have their
 * provenance (the model's verified source, and since TASK-1012 a source per fact), and
 * the coverage matches the declared features.
 */
function checkSimulation(model: CatalogModel, generic: boolean, where: Record<string, unknown>): void {
  const { simulation } = model;
  const simulated = simulation.coverage !== "NOT_SIMULATABLE";
  if ((model.runtimeSupport === "DEVICE_SIM") !== simulated) {
    throw fail(
      "A model the device simulator executes declares its behaviour profile and coverage; a model it does not execute is NOT_SIMULATABLE.",
      { ...where, runtimeSupport: model.runtimeSupport, coverage: simulation.coverage },
    );
  }
  if (!isSimulated(model)) {
    const named = model.terminals.find((terminal) => terminal.simulatorSignal);
    if (named) {
      throw fail("A terminal names a simulator signal, but the model is not simulated.", {
        ...where,
        terminal: named.terminalLabel,
      });
    }
    return;
  }
  const { profile: key, profileVersion, parameters } = model.simulation;
  const profile = findBehaviorProfile(key);
  if (!profile) throw fail("A model names a behaviour profile that does not exist.", { ...where, profile: key });
  if (profile.version !== profileVersion) {
    throw fail("A model names a version of its behaviour profile that does not exist.", {
      ...where,
      profile: key,
      profileVersion,
      known: profile.version,
    });
  }
  if (!profile.runsOn.server) {
    throw fail(
      "The server's device simulator does not run this behaviour profile yet; the model is NOT_SIMULATABLE until TASK-1015 moves factories to the runtime.",
      { ...where, profile: key },
    );
  }
  const categoryType = GENERIC_CATEGORIES.find((category) => category.code === model.category)?.simulatorType;
  if (categoryType !== profile.simulatorType) {
    throw fail("A model's behaviour profile is the one of its category.", {
      ...where,
      profile: key,
      category: model.category,
    });
  }
  // Generic and vendor facts stay apart: a generic model has nothing model-specific; a
  // vendor model's model-specific behaviour is a fact that needs its verified source.
  if (generic && model.simulation.coverage !== "GENERIC") {
    throw fail("A generic model has no model-specific behaviour: its coverage is GENERIC or NOT_SIMULATABLE.", where);
  }
  if (generic && Object.keys(model.simulation.sources).length > 0) {
    throw fail("A generic model states no vendor fact, so it names no source for one.", where);
  }
  const modelSpecific =
    model.simulation.coverage !== "GENERIC" || Object.keys(parameters).length > 0 || model.simulation.faults.length > 0;
  if (!generic && modelSpecific && model.verification.status !== "VERIFIED") {
    throw fail(
      "Model-specific behaviour of a vendor model (PARTIAL or FULL coverage, parameter values, supported faults) needs its VERIFIED provenance.",
      { ...where, coverage: model.simulation.coverage },
    );
  }
  if ("features" in model.simulation) {
    const { features, coverage } = model.simulation;
    if (new Set(features.map((feature) => feature.key)).size !== features.length) {
      throw fail("A feature is declared twice.", where);
    }
    const implemented = features.filter((feature) => feature.implemented).length;
    if (coverage === "FULL" && implemented !== features.length) {
      throw fail("FULL coverage means every declared feature is implemented.", { ...where, implemented });
    }
    if (coverage === "PARTIAL" && (implemented === 0 || implemented === features.length)) {
      throw fail("PARTIAL coverage means some declared features are implemented and some are not.", {
        ...where,
        implemented,
        declared: features.length,
      });
    }
  }
  checkProfileUse(model, profile, where);
  if (!generic) checkFactSources(model, where);
}

/**
 * Every model-specific fact of a vendor model names where it was read (TASK-1012): each
 * parameter value, declared feature and supported fault has a source, every source points
 * at a fact the model declares, and a named document is one of the model's.
 */
function checkFactSources(model: SimulatedCatalogModel, where: Record<string, unknown>) {
  const { sources, parameters, faults } = model.simulation;
  const declared = new Set<string>([
    ...Object.keys(parameters).map((key) => factKey("parameter", key)),
    ...faults.map((code) => factKey("fault", code)),
    ...("features" in model.simulation ? model.simulation.features.map((f) => factKey("feature", f.key)) : []),
  ]);
  for (const fact of declared) {
    if (!sources[fact]) {
      throw fail("A model-specific fact of a vendor model names the manufacturer document it was read from.", {
        ...where,
        fact,
      });
    }
  }
  for (const [fact, source] of Object.entries(sources)) {
    if (!declared.has(fact)) {
      throw fail("A fact source names a parameter, feature or fault the model does not declare.", { ...where, fact });
    }
    if (source.document !== undefined && !model.documents[source.document]) {
      throw fail("A fact source names a document the model does not list.", {
        ...where,
        fact,
        document: source.document,
      });
    }
  }
}

/**
 * The source of one fact of a model, resolved to its document: the named one, else the
 * model's verification source. Null for a generic model (it has no vendor facts).
 */
export function resolveFactSource(
  model: Pick<CatalogModel, "documents" | "verification">,
  source: CatalogFactSource,
): { reference: string; note: string | null; document: CatalogSource | null } {
  const own = model.verification.status === "GENERIC" ? undefined : model.verification.source;
  const document = source.document !== undefined ? model.documents[source.document] : own;
  return { reference: source.reference, note: source.note ?? null, document: document ?? null };
}

function checkProfileUse(model: SimulatedCatalogModel, profile: BehaviorProfile, where: Record<string, unknown>) {
  for (const terminal of model.terminals) {
    if (!terminal.simulatorSignal) continue;
    const signal = profile.signals.find((candidate) => candidate.key === terminal.simulatorSignal);
    // A terminal the device reads is a simulator input; one it drives is a simulator output.
    const consistent =
      signal &&
      (signal.direction === "IN") === (terminal.direction === "INPUT") &&
      (signal.kind === "BOOL") === (terminal.ioType === "DIGITAL");
    if (!consistent) {
      throw fail("A terminal names a simulator signal its device type does not have in that direction.", {
        ...where,
        terminal: terminal.terminalLabel,
      });
    }
  }
  for (const code of model.simulation.faults) {
    if (!profile.faults.some((fault) => fault.code === code)) {
      throw fail("A model lists a fault its behaviour model does not support.", { ...where, fault: code });
    }
  }
  for (const [key, value] of Object.entries(model.simulation.parameters)) {
    const parameter = profile.parameters.find((candidate) => candidate.key === key);
    if (!parameter) {
      throw fail("A model sets a parameter its behaviour profile does not have.", { ...where, parameter: key });
    }
    const reason = checkParameterValue(parameter, value);
    if (reason) {
      throw fail("A model sets a parameter outside the bounds of its behaviour profile.", {
        ...where,
        parameter: key,
        reason,
      });
    }
  }
}

/** Validates catalog definitions and their cross-references; throws `DomainError` on the first problem. */
export function parseCatalog(input: unknown): Catalog {
  const result = catalogSchema.safeParse(input);
  if (!result.success) {
    throw fail("The catalog definitions are not valid.", {
      issues: result.error.issues.slice(0, 10).map((issue) => ({ path: issue.path.join("."), message: issue.message })),
    });
  }
  const catalog = result.data;
  const manufacturers = new Set(catalog.manufacturers.map((manufacturer) => manufacturer.name));
  if (manufacturers.size !== catalog.manufacturers.length) throw fail("A manufacturer is listed twice.", {});

  const modelKeys = new Set<string>();
  for (const model of catalog.models) {
    checkModel(model, manufacturers);
    const key = `${model.manufacturer}/${model.family}/${model.modelName}`;
    if (modelKeys.has(key)) throw fail("A model is defined twice.", { model: key });
    modelKeys.add(key);
  }
  // A family belongs to one category.
  const familyCategory = new Map<string, string>();
  for (const model of catalog.models) {
    const key = `${model.manufacturer}/${model.family}`;
    const known = familyCategory.get(key);
    if (known && known !== model.category) throw fail("A family mixes device categories.", { family: key });
    familyCategory.set(key, model.category);
  }
  for (const rack of catalog.racks) {
    if (familyCategory.get(`${rack.manufacturer}/${rack.family}`) !== PLC_CATEGORY_CODE) {
      throw fail("A rack belongs to a PLC family that is defined.", { rack: rack.name });
    }
  }
  for (const definition of catalog.modules) {
    const where = { module: `${definition.manufacturer} ${definition.modelName}` };
    if (definition.verification.status === "GENERIC") throw fail("Modules are vendor records.", where);
    for (const cpu of definition.compatibleCpus) {
      const cpuModel = catalog.models.find(
        (model) =>
          model.manufacturer === definition.manufacturer &&
          model.family === definition.family &&
          model.modelName === cpu,
      );
      if (cpuModel?.architectureType !== "MODULAR") {
        throw fail("A module is compatible only with modular CPUs of its own family.", { ...where, cpu });
      }
    }
  }
  return catalog;
}
