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
import { IO_DIRECTIONS, IO_POINT_TYPES, IO_SIGNAL_CLASSES, PLC_CATEGORY_CODE } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";
import { DEVICE_FAULTS, findSignal, isSimulatedType } from "@/lib/domain/simulation";

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
  notes: text.optional(),
});

/** A terminal of a peripheral, seen from the device, optionally tied to a simulator signal. */
const terminalSchema = z.strictObject({
  terminalLabel: text,
  direction: z.enum(IO_DIRECTIONS),
  ioType: z.enum(IO_SIGNAL_CLASSES),
  signalType,
  rangeMin: z.number().optional(),
  rangeMax: z.number().optional(),
  unit: z.string().max(16).optional(),
  /** Signal of the device's behaviour model this terminal carries (lib/domain/simulation.ts). */
  simulatorSignal: z.string().max(64).optional(),
  notes: text.optional(),
});

const modelSchema = z.strictObject({
  manufacturer: text,
  category: z.enum(GENERIC_CATEGORIES.map((category) => category.code) as [string, ...string[]]),
  family: text,
  modelName: text,
  sku: text.optional(),
  architectureType: z.enum(["COMPACT", "MODULAR"]).optional(),
  runtimeSupport: z.enum(["OPENPLC", "DEVICE_SIM", "MODBUS_SIM", "EXTERNAL", "NONE"]),
  controlCapability: z.enum(CONTROL_CAPABILITIES),
  lifecycleStatus: z.enum(["ACTIVE", "PHASED_OUT", "DISCONTINUED", "UNKNOWN"]).default("UNKNOWN"),
  verification: verificationSchema,
  electrical: electricalSchema.optional(),
  ports: z.array(portSchema).default([]),
  builtInChannels: z.array(channelGroupSchema).default([]),
  terminals: z.array(terminalSchema).default([]),
  /** Fault codes of the generic behaviour model this device supports. */
  faults: z.array(text).default([]),
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

  const isPlc = model.category === PLC_CATEGORY_CODE;
  if (isPlc !== (model.architectureType !== undefined)) {
    throw fail("A PLC model, and only a PLC model, declares its architecture.", where);
  }
  if (model.architectureType === "MODULAR" && model.builtInChannels.length > 0) {
    throw fail("A modular PLC takes its I/O from modules, not built-in channels.", where);
  }
  if (!isPlc && model.builtInChannels.length > 0) throw fail("Only a PLC has built-in PLC channels.", where);

  const labels = model.terminals.map((terminal) => terminal.terminalLabel);
  if (new Set(labels).size !== labels.length) throw fail("Terminal labels must be unique within a model.", where);

  const simulatorType = GENERIC_CATEGORIES.find((category) => category.code === model.category)?.simulatorType;
  const simulated = simulatorType !== undefined && isSimulatedType(simulatorType) ? simulatorType : undefined;
  for (const terminal of model.terminals) {
    if (!terminal.simulatorSignal) continue;
    const signal = simulated ? findSignal(simulated, terminal.simulatorSignal) : undefined;
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
  for (const code of model.faults) {
    if (!simulated || !DEVICE_FAULTS[simulated].some((fault) => fault.code === code)) {
      throw fail("A model lists a fault its behaviour model does not support.", { ...where, fault: code });
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
