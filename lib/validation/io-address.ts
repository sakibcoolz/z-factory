/**
 * Runtime addresses of PLC I/O points (docs/openplc-runtime.md, ADR-0010). Pure functions.
 *
 * Outputs live in the PLC's output image (%Q). Inputs live in memory (%M), because the
 * OpenPLC runtime accepts simulated field values only there. The vendor's own terminal
 * and address names stay on the catalog channel; these are the addresses a program
 * running in Z-Factory uses.
 */
import type { IoPointType } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";

const PREFIX: Record<IoPointType, string> = { DI: "%MX", DO: "%QX", AI: "%MW", AO: "%QW" };

/** Points of one class a PLC can have; keeps I/O inside the lower part of each address area. */
export const IO_POINT_LIMITS: Record<IoPointType, number> = { DI: 1024, DO: 1024, AI: 256, AO: 256 };

const isBitType = (ioType: IoPointType) => ioType === "DI" || ioType === "DO";

/** Address of the `index`-th point of its class: bits as byte.bit, analog values as words. */
export function ioPointAddress(ioType: IoPointType, index: number): string {
  if (!Number.isInteger(index) || index < 0 || index >= IO_POINT_LIMITS[ioType]) {
    throw new DomainError("INVARIANT", `This PLC has no room for another ${ioType} point.`, {
      rule: "io-point-limit",
      ioType,
      limit: IO_POINT_LIMITS[ioType],
    });
  }
  return isBitType(ioType) ? `${PREFIX[ioType]}${Math.floor(index / 8)}.${index % 8}` : `${PREFIX[ioType]}${index}`;
}

/** The point index an address stands for, or undefined when it is not an I/O point address of that class. */
export function ioPointIndex(ioType: IoPointType, address: string): number | undefined {
  const prefix = PREFIX[ioType];
  if (!address.startsWith(prefix)) return undefined;
  const rest = address.slice(prefix.length);
  const match = isBitType(ioType) ? /^(\d+)\.([0-7])$/.exec(rest) : /^(\d+)$/.exec(rest);
  if (!match) return undefined;
  return isBitType(ioType) ? Number(match[1]) * 8 + Number(match[2]) : Number(match[1]);
}

/**
 * First index for a block of `count` new points: after everything in use, with digital
 * blocks starting on a byte. Existing addresses never move when a module is added.
 */
export function nextBlockIndex(ioType: IoPointType, usedIndexes: readonly number[], count: number): number {
  const next = usedIndexes.length === 0 ? 0 : Math.max(...usedIndexes) + 1;
  const start = isBitType(ioType) ? Math.ceil(next / 8) * 8 : next;
  // Fails when the block does not fit.
  ioPointAddress(ioType, start + count - 1);
  return start;
}

/** `VFD-01` + `RUN` → `VFD_01_RUN`: a tag name usable as an IEC identifier. */
export function tagNameFor(deviceName: string, terminalLabel: string | null): string {
  const raw = [deviceName, terminalLabel ?? "IO"].join("_");
  const name = raw
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 60);
  return /^[A-Za-z_]/.test(name) ? name : `T_${name}`;
}

/** `VFD` with `VFD-01`, `VFD-02` taken → `VFD-03`. */
export function suggestDeviceName(categoryCode: string, existingNames: readonly string[]): string {
  const prefix = categoryCode.replace(/_/g, "-");
  const taken = new Set(existingNames.map((name) => name.toUpperCase()));
  for (let number = 1; number < 1000; number += 1) {
    const candidate = `${prefix}-${String(number).padStart(2, "0")}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${prefix}-${existingNames.length + 1}`;
}

/** Default tag scale for an analog signal: enough resolution for its usual range in an INT16. */
export function defaultAnalogScale(unit: string | undefined): number {
  if (unit === "rpm") return 1;
  if (unit === "Hz" || unit === "A" || unit === "%") return 0.01;
  return 0.1;
}
