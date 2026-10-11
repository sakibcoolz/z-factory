/**
 * Capability sets shared by catalog records (docs/programmable-devices.md). What Z-Factory
 * can do with a model, not a claim about vendor firmware: a vendor PLC is programmed and
 * run through the OpenPLC adapter, whose runtime serves its registers over Modbus TCP.
 */
import type { CatalogInput } from "@/lib/catalog/schema";
import type { DeviceCapability } from "@/lib/domain/device-capabilities";

/** A PLC programmed in IEC 61131-3 and run by the OpenPLC adapter. */
export const PLC_CAPABILITIES: readonly DeviceCapability[] = ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER"];

/**
 * The simulation decision of a programmable controller (TASK-1010): its program runs on
 * the OpenPLC adapter; the device simulator has no behaviour model of a PLC, and no vendor
 * firmware runs anywhere.
 */
export const PLC_SIMULATION: CatalogInput["models"][number]["simulation"] = {
  coverage: "NOT_SIMULATABLE",
  reason:
    "A programmable controller: its program runs on the OpenPLC adapter. The device simulator models no PLC, and no vendor firmware runs.",
};
