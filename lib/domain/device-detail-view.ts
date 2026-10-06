/**
 * Shapes the device screens render (TASK-308, docs/programmable-devices.md). Pure types;
 * importable anywhere.
 */
import type { DeviceCapability, DeviceSection } from "@/lib/domain/device-capabilities";
import type { ParameterField } from "@/lib/domain/device-parameters";
import type { RuntimeState } from "@/lib/domain/runtime-state";
import type { ModbusArea, TagDataType, TagRole } from "@/lib/domain/tag";
import type { WireView } from "@/lib/domain/wiring-view";
import type { PlcArchitecture } from "@/lib/domain/device";

export type DeviceRegisterView = {
  tagName: string;
  /** The controller that holds the tag. */
  plcId: string;
  plcName: string;
  role: TagRole;
  dataType: TagDataType;
  logicalAddress: string | null;
  area: ModbusArea | null;
  address: number | null;
  /** `40001`-style address, for people. */
  displayAddress: string | null;
  /** The signal of the device's behaviour model the tag carries. */
  signal: string | null;
  unit: string | null;
};

export type DeviceParameterVersion = {
  version: number;
  createdAt: string;
  createdBy: string;
  values: Record<string, number>;
};

export type DeviceParametersView = {
  fields: ParameterField[];
  values: Record<string, number>;
  /** False when the model is not simulated: the values are kept for the record and drive nothing. */
  applied: boolean;
  /** Immutable parameter sets, newest first. */
  versions: DeviceParameterVersion[];
};

export type DeviceDetailView = {
  id: string;
  factoryId: string;
  factoryName: string;
  factorySlug: string;
  name: string;
  role: string | null;
  location: string | null;
  runtimeStatus: RuntimeState;
  categoryCode: string;
  categoryName: string;
  manufacturer: string;
  modelId: string;
  modelName: string;
  architectureType: PlcArchitecture | null;
  runtimeSupport: string;
  simulatorType: string;
  capabilities: DeviceCapability[];
  /** The screens this device has, in order, with their labels. */
  sections: Array<{ key: DeviceSection; label: string }>;
  /** Why no program can be written for the model, when it is programmable but has no adapter. */
  programNote: string | null;
  ports: Array<{ name: string; physicalType: string; protocols: string[]; maxConnections: number }>;
  wires: WireView[];
  registers: DeviceRegisterView[];
  parameters: DeviceParametersView | null;
};
