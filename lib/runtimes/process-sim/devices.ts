import "server-only";
import { DomainError } from "@/lib/domain/errors";
import { DEVICE_PROFILES, type DeviceSimDeviceConfig } from "@/lib/domain/process-sim";
import type { DeviceConfig } from "@/lib/runtimes/device-sim/engine";

/**
 * Turns the server's device-simulation configuration of a factory into what the catalog
 * device runtime takes (TASK-1009): the behaviour profile from the device's simulated
 * type (`DEVICE_PROFILES`, the catalog's simulation metadata), the parameters as they
 * are, the catalog's fault overrides, and the relationships as links by role. One
 * source for both simulators until TASK-1015 switches factories over.
 */
export function toDeviceSimDevice(config: DeviceConfig): DeviceSimDeviceConfig {
  const profile = DEVICE_PROFILES[config.type];
  if (!profile) {
    throw new DomainError("INCOMPATIBLE", `Device type ${String(config.type)} has no behaviour profile.`, {
      rule: "simulated-type",
      device: config.name,
    });
  }
  const links: Record<string, string> = {};
  if (config.driveId) links.drive = config.driveId;
  if (config.motorId) links.motor = config.motorId;
  if (config.measuresId) links.measures = config.measuresId;
  return {
    deviceId: config.id,
    name: config.name,
    ...profile,
    ...(config.params === undefined ? {} : { parameters: config.params }),
    ...(config.faults ? { faults: config.faults } : {}),
    ...(Object.keys(links).length > 0 ? { links } : {}),
  };
}

export function toDeviceSimDevices(devices: readonly DeviceConfig[]): DeviceSimDeviceConfig[] {
  return devices.map(toDeviceSimDevice);
}
