/**
 * Shapes the PLC configuration service returns and the PLC screens render
 * (docs/design.md → PLC creation flow, PLC edit). Pure types; importable anywhere.
 */
import type { VerificationStatus } from "@/lib/domain/catalog";
import type { DeviceCapability } from "@/lib/domain/device-capabilities";
import type { ChannelSummary } from "@/lib/domain/catalog-view";
import type { IoPointStatus, IoPointType, PlcArchitecture } from "@/lib/domain/device";
import type { RuntimeState } from "@/lib/domain/runtime-state";

export type PlcPointView = {
  id: string;
  ioType: IoPointType;
  /** Short label for the pin view: the documented terminal label, else the channel number. */
  label: string;
  /** The vendor's own address for the channel, where its documentation prints one. */
  vendorAddress: string | null;
  /** Address the program uses in Z-Factory. */
  logicalAddress: string;
  signalTypes: string[];
  status: IoPointStatus;
  device: { id: string; name: string; terminalLabel: string | null } | null;
  tagName: string | null;
};

/** A run of points of one class from one source: the CPU's built-in I/O or one module. */
export type PlcBankView = {
  key: string;
  label: string;
  ioType: IoPointType;
  slotIndex: number | null;
  points: PlcPointView[];
};

export type PlcSlotView = {
  slotIndex: number;
  module: null | {
    id: string;
    modelName: string;
    sku: string | null;
    moduleType: string;
    pointCount: number;
    occupiedCount: number;
  };
};

export type PlcPeripheralView = {
  deviceId: string;
  name: string;
  role: string | null;
  modelName: string;
  categoryName: string;
  connection: "DIRECT_IO" | "PROTOCOL";
  protocols: string[];
  wires: Array<{
    terminalLabel: string | null;
    ioType: IoPointType;
    pointLabel: string;
    logicalAddress: string;
    tagName: string | null;
  }>;
};

export type PlcConfigurationView = {
  plc: {
    id: string;
    factoryId: string;
    name: string;
    role: string | null;
    runtimeStatus: RuntimeState;
    architectureType: PlcArchitecture;
    ioMappingVersion: number;
    modbusMappingVersion: number;
  };
  model: {
    id: string;
    manufacturer: string;
    family: string;
    modelName: string;
    sku: string | null;
    verificationStatus: VerificationStatus;
    /** PLC or RTU: the kind of controller the model is. */
    categoryCode: string;
    /** What Z-Factory can do with the model; the screens follow these (TASK-308). */
    capabilities: DeviceCapability[];
    runtimeSupport: string;
  };
  electrical: {
    supplyType: string | null;
    nominalVoltage: number | null;
    voltageMin: number | null;
    voltageMax: number | null;
  } | null;
  ports: Array<{ name: string; physicalType: string; protocols: string[]; portCount: number }>;
  /** Rack of a modular PLC; null for a compact one. */
  rack: null | { name: string; slotCount: number; slots: PlcSlotView[] };
  banks: PlcBankView[];
  occupancy: { total: number; occupied: number };
  peripherals: PlcPeripheralView[];
};

export type InstallableModuleView = {
  id: string;
  modelName: string;
  sku: string | null;
  moduleType: string;
  channels: ChannelSummary[];
};

export type FactoryDeviceView = {
  id: string;
  name: string;
  role: string | null;
  modelName: string;
  manufacturer: string;
  categoryCode: string;
  categoryName: string;
  architectureType: PlcArchitecture | null;
  runtimeStatus: RuntimeState;
};

/** A PLC catalog model as offered in the create form. */
export type PlcModelOption = {
  id: string;
  manufacturer: string;
  family: string;
  modelName: string;
  sku: string | null;
  verificationStatus: string;
  /** "14 DI · 10 DO · 2 AI" for a compact PLC, "4 installable modules" for a modular one. */
  io: string;
  ports: string;
};
