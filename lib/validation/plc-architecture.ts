/**
 * Compact vs modular PLC rules (ADR-0003). Pure functions; they throw `DomainError`.
 *
 * - Every PLC catalog model declares COMPACT or MODULAR; no other category does.
 * - Compact PLCs expose built-in I/O directly and have no rack.
 * - Modular PLCs take their I/O from modules installed in rack slots, unless the CPU
 *   itself documents onboard I/O.
 */
import { type IoPointSource, PLC_CATEGORY_CODE, type PlcArchitecture } from "@/lib/domain/device";
import { DomainError } from "@/lib/domain/errors";

export function assertModelArchitecture(model: {
  categoryCode: string;
  architectureType: PlcArchitecture | null;
}): void {
  const isPlc = model.categoryCode === PLC_CATEGORY_CODE;
  if (isPlc && model.architectureType === null) {
    throw new DomainError("VALIDATION", "A PLC model must declare a COMPACT or MODULAR architecture.", {
      rule: "plc-architecture-required",
    });
  }
  if (!isPlc && model.architectureType !== null) {
    throw new DomainError("VALIDATION", "Only PLC models declare an architecture.", {
      rule: "architecture-plc-only",
    });
  }
}

export function assertRackAllowed(architecture: PlcArchitecture): void {
  if (architecture !== "MODULAR") {
    throw new DomainError("INCOMPATIBLE", "A compact PLC has no rack; only modular PLCs take racks and modules.", {
      rule: "rack-modular-only",
    });
  }
}

export function assertIoPointSource(point: {
  architecture: PlcArchitecture;
  sourceType: IoPointSource;
  /** True when the catalog model documents built-in channels. */
  cpuHasOnboardIo: boolean;
}): void {
  if (point.architecture === "COMPACT" && point.sourceType === "MODULE") {
    throw new DomainError("INCOMPATIBLE", "A compact PLC takes its I/O from built-in channels, not rack modules.", {
      rule: "compact-built-in-only",
    });
  }
  if (point.sourceType === "BUILT_IN" && !point.cpuHasOnboardIo) {
    throw new DomainError("INCOMPATIBLE", "This PLC model documents no built-in I/O; install a module instead.", {
      rule: "built-in-requires-onboard-io",
    });
  }
}

export type ModuleCompatibilityRule = {
  cpuModelId: string;
  minSlot: number | null;
  maxSlot: number | null;
};

export function assertModulePlacement(placement: {
  cpuModelId: string;
  rackSlotCount: number;
  occupiedSlots: readonly number[];
  slotIndex: number;
  /** Compatibility records of the module being installed. */
  compatibility: readonly ModuleCompatibilityRule[];
}): void {
  const { slotIndex, rackSlotCount } = placement;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= rackSlotCount) {
    throw new DomainError("VALIDATION", `Slot ${slotIndex} does not exist; the rack has ${rackSlotCount} slots.`, {
      rule: "slot-in-range",
    });
  }
  if (placement.occupiedSlots.includes(slotIndex)) {
    throw new DomainError("OCCUPIED_ENDPOINT", `Slot ${slotIndex} already holds a module.`, {
      rule: "slot-free",
    });
  }
  const rule = placement.compatibility.find((candidate) => candidate.cpuModelId === placement.cpuModelId);
  if (!rule) {
    throw new DomainError("INCOMPATIBLE", "This module is not compatible with the PLC's CPU model.", {
      rule: "module-cpu-compatible",
    });
  }
  const belowMin = rule.minSlot !== null && slotIndex < rule.minSlot;
  const aboveMax = rule.maxSlot !== null && slotIndex > rule.maxSlot;
  if (belowMin || aboveMax) {
    throw new DomainError("INCOMPATIBLE", `This module cannot be installed in slot ${slotIndex}.`, {
      rule: "module-slot-range",
      minSlot: rule.minSlot,
      maxSlot: rule.maxSlot,
    });
  }
}
