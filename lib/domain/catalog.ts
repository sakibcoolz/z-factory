/**
 * Catalog vocabulary (docs/device-catalog.md). Pure data; importable anywhere.
 */

/** Normalized electrical signal codes used to match a device terminal to a PLC channel. */
export const SIGNAL_TYPES = [
  "DC_24V",
  "VOLTAGE_0_10V",
  "VOLTAGE_0_5V",
  "VOLTAGE_1_5V",
  "VOLTAGE_PM_10V",
  "CURRENT_4_20MA",
  "CURRENT_0_20MA",
  "CURRENT_PM_20MA",
] as const;
export type SignalType = (typeof SIGNAL_TYPES)[number];

export const SIGNAL_TYPE_LABELS: Record<SignalType, string> = {
  DC_24V: "24 V DC",
  VOLTAGE_0_10V: "0–10 V",
  VOLTAGE_0_5V: "0–5 V",
  VOLTAGE_1_5V: "1–5 V",
  VOLTAGE_PM_10V: "±10 V",
  CURRENT_4_20MA: "4–20 mA",
  CURRENT_0_20MA: "0–20 mA",
  CURRENT_PM_20MA: "±20 mA",
};

/**
 * Signal ranges that lie inside a wider one. A channel set up for the wider range can carry
 * the narrower signal (a ±10 V input measures a 0–10 V signal). This is a Z-Factory
 * compatibility rule about ranges, not a statement from any vendor.
 */
const CONTAINED_SIGNALS: Partial<Record<SignalType, readonly SignalType[]>> = {
  VOLTAGE_PM_10V: ["VOLTAGE_0_10V", "VOLTAGE_0_5V", "VOLTAGE_1_5V"],
  VOLTAGE_0_10V: ["VOLTAGE_0_5V", "VOLTAGE_1_5V"],
  VOLTAGE_0_5V: ["VOLTAGE_1_5V"],
  CURRENT_PM_20MA: ["CURRENT_0_20MA", "CURRENT_4_20MA"],
  CURRENT_0_20MA: ["CURRENT_4_20MA"],
};

/** True when a channel supporting `supported` can carry a `signal`. */
export function signalFits(supported: string, signal: string): boolean {
  return supported === signal || (CONTAINED_SIGNALS[supported as SignalType] ?? []).includes(signal as SignalType);
}

/** Mirrors the database enum `ControlCapability`. Declared per model, never inferred from a category. */
export const CONTROL_CAPABILITIES = [
  "DIRECT_IO",
  "PARAMETER_CONFIGURED",
  "PROTOCOL_CONTROLLED",
  "PROGRAMMABLE",
] as const;
export type ControlCapability = (typeof CONTROL_CAPABILITIES)[number];

export const CONTROL_CAPABILITY_LABELS: Record<ControlCapability, string> = {
  DIRECT_IO: "direct PLC I/O",
  PARAMETER_CONFIGURED: "parameter-configured",
  PROTOCOL_CONTROLLED: "protocol-controlled",
  PROGRAMMABLE: "programmable",
};

/** Mirrors the database enum `DriveType`. */
export const DRIVE_TYPES = ["VFD", "SERVO", "SOFT_STARTER", "DIRECT_ON_LINE"] as const;
export type DriveType = (typeof DRIVE_TYPES)[number];

/** Mirrors the database enum `VerificationStatus`. */
export const VERIFICATION_STATUSES = ["UNVERIFIED", "VERIFIED", "GENERIC"] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
