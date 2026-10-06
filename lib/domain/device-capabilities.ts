/**
 * What Z-Factory can do with a catalog model, and which screens follow from it
 * (docs/programmable-devices.md, TASK-308). Capabilities are declared per model in the
 * catalog; nothing here is inferred from a category or a device name. Pure; importable anywhere.
 */
import type { PlcArchitecture } from "@/lib/domain/device";

/** Mirrors the database enum `DeviceCapability`. */
export const DEVICE_CAPABILITIES = [
  "PROGRAMMABLE",
  "IEC_61131_3",
  "SCRIPTABLE",
  "PARAMETER_CONFIGURABLE",
  "LOCAL_CONTROL",
  "REMOTE_CONTROL",
  "DATA_LOGGING",
  "MODBUS_CLIENT",
  "MODBUS_SERVER",
  "REMOTE_IO",
  "FIRMWARE_DEPLOYABLE",
] as const;
export type DeviceCapability = (typeof DEVICE_CAPABILITIES)[number];

export const DEVICE_CAPABILITY_LABELS: Record<DeviceCapability, string> = {
  PROGRAMMABLE: "programmable",
  IEC_61131_3: "IEC 61131-3",
  SCRIPTABLE: "scriptable",
  PARAMETER_CONFIGURABLE: "parameter-configurable",
  LOCAL_CONTROL: "local control",
  REMOTE_CONTROL: "remote control",
  DATA_LOGGING: "data logging",
  MODBUS_CLIENT: "Modbus client",
  MODBUS_SERVER: "Modbus server",
  REMOTE_IO: "remote I/O",
  FIRMWARE_DEPLOYABLE: "firmware deployable",
};

/** Categories whose models may be programmable controllers: they declare an architecture and run a program. */
export const CONTROLLER_CATEGORY_CODES: readonly string[] = ["PLC", "RTU"];

/** The facts of a model the screens are assembled from. */
export type ModelCapabilities = {
  categoryCode: string;
  capabilities: readonly DeviceCapability[];
  runtimeSupport: string;
  architectureType: PlcArchitecture | null;
  simulatorType: string;
  hasPorts: boolean;
};

export const hasCapability = (model: Pick<ModelCapabilities, "capabilities">, capability: DeviceCapability) =>
  model.capabilities.includes(capability);

/**
 * A programmable controller: a model that runs a user program on an adapter Z-Factory
 * has. It gets a controller profile, I/O points, a program and a runtime of its own.
 */
export function isProgrammableController(model: Pick<ModelCapabilities, "capabilities" | "architectureType">) {
  return hasCapability(model, "PROGRAMMABLE") && model.architectureType !== null;
}

/**
 * Whether the program workflow can run for the model: it is programmable in an IEC 61131-3
 * language and the OpenPLC adapter is its runtime. A programmable model without that
 * adapter is shown as programmable, but nothing can be compiled or deployed for it.
 */
export type ProgramSupport =
  { supported: true; language: "ST"; adapter: "OPENPLC" } | { supported: false; reason: string };

export function programSupport(model: Pick<ModelCapabilities, "capabilities" | "runtimeSupport">): ProgramSupport {
  if (!hasCapability(model, "PROGRAMMABLE")) return { supported: false, reason: "This model runs no user program." };
  if (!hasCapability(model, "IEC_61131_3")) {
    return {
      supported: false,
      reason: "This model is not programmed in an IEC 61131-3 language; no adapter exists for it.",
    };
  }
  if (model.runtimeSupport !== "OPENPLC") {
    return { supported: false, reason: "No runtime adapter runs programs for this model yet." };
  }
  return { supported: true, language: "ST", adapter: "OPENPLC" };
}

/** `PLC · compact`, `RTU · modular`: the kind of a controller, from its category and architecture. */
export function controllerKind(model: {
  categoryCode: string;
  architectureType: PlcArchitecture | null;
}): string | null {
  if (model.architectureType === null) return null;
  const name = model.categoryCode === "RTU" ? "RTU" : "PLC";
  return `${name} · ${model.architectureType.toLowerCase()}`;
}

/** The screens of a device instance, in order. */
export const DEVICE_SECTIONS = [
  "overview",
  "hardware",
  "connections",
  "program",
  "parameters",
  "registers",
  "io-mapping",
  "versions",
  "communications",
  "runtime",
  "export",
] as const;
export type DeviceSection = (typeof DEVICE_SECTIONS)[number];

export const DEVICE_SECTION_LABELS: Record<DeviceSection, string> = {
  overview: "Overview",
  hardware: "Hardware / Pinout",
  connections: "Connections",
  program: "Program",
  parameters: "Parameters",
  registers: "Registers",
  "io-mapping": "I/O Mapping",
  versions: "Versions",
  communications: "Communications",
  runtime: "Runtime",
  export: "Export",
};

/**
 * Which screens a device of this model has. The exact model decides: Program and
 * Versions exist only for a programmable model, Parameters only for a parameter-configurable
 * one, Registers for a model that speaks Modbus, Communications for a model with ports.
 * A controller has hardware, I/O mapping, a runtime and an export of its own.
 */
export function deviceSections(model: ModelCapabilities): DeviceSection[] {
  const controller = isProgrammableController(model);
  const programmable = hasCapability(model, "PROGRAMMABLE");
  const modbus =
    hasCapability(model, "MODBUS_SERVER") || hasCapability(model, "MODBUS_CLIENT") || hasCapability(model, "REMOTE_IO");
  return DEVICE_SECTIONS.filter((section) => {
    switch (section) {
      case "overview":
      case "connections":
        return true;
      case "hardware":
      case "io-mapping":
      case "export":
        return controller;
      case "program":
      case "versions":
        return programmable;
      case "parameters":
        return hasCapability(model, "PARAMETER_CONFIGURABLE");
      case "registers":
        return modbus && !controller;
      case "communications":
        // A controller's network endpoint is configured on its Runtime screen.
        return model.hasPorts && !controller;
      case "runtime":
        return controller || model.simulatorType !== "NONE";
      default:
        return false;
    }
  });
}
