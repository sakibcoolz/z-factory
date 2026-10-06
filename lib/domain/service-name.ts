import { DomainError } from "@/lib/domain/errors";

/**
 * DNS name of a device inside its factory network, e.g. `S7-1200-1214C-01` →
 * `s7-1200-1214c-01`. Deterministic from the name, so another PLC can address it without
 * knowing an IP (docs/docker-runtime.md). Pure; importable anywhere.
 */
export function serviceNameFor(deviceName: string): string {
  const name = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/, "");
  if (!name) throw new DomainError("VALIDATION", "The device name cannot be used as a service name.");
  return name;
}
