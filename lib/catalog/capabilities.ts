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

/**
 * The behaviours Z-Factory declares for a hardwired drive mapped onto the generic VFD
 * profile (TASK-1012), and whether the profile implements each. The list is Z-Factory's;
 * a vendor record that uses it states, per feature, where its manual documents the
 * feature, and a drive whose manual does not document one leaves it out.
 */
export const DRIVE_FEATURES = {
  LINEAR_RAMP: { label: "Linear acceleration and deceleration ramps", implemented: true },
  REVERSAL: { label: "Direction reversal through zero", implemented: true },
  TRIP_RESET: { label: "Overcurrent and overtemperature trips, reset by command or operator", implemented: true },
  S_RAMP: { label: "S-ramp / ramp rounding", implemented: false },
  DC_BRAKE: { label: "DC injection braking", implemented: false },
  CURRENT_LIMIT: { label: "Current limitation", implemented: false },
  AUTO_RESTART: { label: "Automatic fault reset and restart", implemented: false },
  FLYING_START: { label: "Flying start / catch on the fly", implemented: false },
  PID: { label: "Built-in PID regulator", implemented: false },
} as const;
export type DriveFeatureKey = keyof typeof DRIVE_FEATURES;

/** The declared features of a drive record, in a fixed order, as the catalog schema wants them. */
export const driveFeatures = (keys: readonly DriveFeatureKey[]) => keys.map((key) => ({ key, ...DRIVE_FEATURES[key] }));
