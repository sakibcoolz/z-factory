/**
 * Capability sets shared by catalog records (docs/programmable-devices.md). What Z-Factory
 * can do with a model, not a claim about vendor firmware: a vendor PLC is programmed and
 * run through the OpenPLC adapter, whose runtime serves its registers over Modbus TCP.
 */
import type { DeviceCapability } from "@/lib/domain/device-capabilities";

/** A PLC programmed in IEC 61131-3 and run by the OpenPLC adapter. */
export const PLC_CAPABILITIES: readonly DeviceCapability[] = ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER"];
