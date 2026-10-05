/**
 * Shapes the PLC configuration service returns and the PLC screens render
 * (docs/design.md → PLC creation flow, PLC edit). Pure types; importable anywhere.
 */
import type { VerificationStatus } from "@/lib/domain/catalog";
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

/** A catalog peripheral and whether this PLC has room for it right now. */
export type AddablePeripheralView = {
  modelId: string;
  manufacturer: string;
  modelName: string;
  categoryCode: string;
  categoryName: string;
  connection: "DIRECT_IO" | "PROTOCOL" | null;
  fits: boolean;
  /** Why it fits or what is missing, e.g. "2 × DI, 1 × DO" or "no free AO 0–10 V". */
  detail: string;
};

/** What the "add peripheral" form needs for one catalog model. */
export type PeripheralOptionsView = {
  model: { id: string; modelName: string; categoryName: string };
  suggestedName: string;
  connection: "DIRECT_IO" | "PROTOCOL" | null;
  protocols: string[];
  terminals: Array<{
    id: string;
    terminalLabel: string | null;
    required: IoPointType;
    signalType: string;
    simulatorSignal: string | null;
    /** Free channels that can take this terminal. */
    options: Array<{ pointId: string; label: string; logicalAddress: string }>;
    suggestedPointId: string | null;
  }>;
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
