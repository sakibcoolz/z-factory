/** Tag mapping invariants: command/setpoint vs feedback, and Modbus area permissions. */
import { DomainError } from "@/lib/domain/errors";
import {
  type AccessMode,
  isWritableModbusArea,
  isWritableTagRole,
  type ModbusArea,
  type TagDataType,
  type TagRole,
  wordCountFor,
} from "@/lib/domain/tag";

export function assertTagAccess(tag: {
  role: TagRole;
  accessMode: AccessMode;
  protocolArea?: ModbusArea | null;
}): void {
  if (tag.accessMode !== "READ_WRITE") return;
  if (!isWritableTagRole(tag.role)) {
    throw new DomainError("INVARIANT", `A ${tag.role} tag is read-only; only COMMAND and SETPOINT tags are writable.`, {
      rule: "writable-role",
    });
  }
  if (tag.protocolArea && !isWritableModbusArea(tag.protocolArea)) {
    throw new DomainError("INCOMPATIBLE", `Modbus area ${tag.protocolArea} is read-only.`, {
      rule: "writable-area",
    });
  }
}

/** BOOL lives in bit areas, numeric types in register areas. */
export function assertTagArea(tag: { dataType: TagDataType; protocolArea: ModbusArea }): void {
  const bitArea = tag.protocolArea === "COIL" || tag.protocolArea === "DISCRETE_INPUT";
  if ((tag.dataType === "BOOL") !== bitArea) {
    throw new DomainError("INCOMPATIBLE", `${tag.dataType} cannot be mapped to ${tag.protocolArea}.`, {
      rule: "data-type-area",
    });
  }
}

type AddressRange = { name: string; protocolArea: ModbusArea; protocolAddress: number; dataType: TagDataType };

/** Rejects a mapping whose register range overlaps an existing mapping in the same area. */
export function assertNoAddressOverlap(candidate: AddressRange, existing: readonly AddressRange[]): void {
  const start = candidate.protocolAddress;
  const end = start + wordCountFor(candidate.dataType) - 1;
  for (const other of existing) {
    if (other.protocolArea !== candidate.protocolArea || other.name === candidate.name) continue;
    const otherEnd = other.protocolAddress + wordCountFor(other.dataType) - 1;
    if (start <= otherEnd && other.protocolAddress <= end) {
      throw new DomainError(
        "CONFLICT",
        `Address ${start}${end > start ? `–${end}` : ""} in ${candidate.protocolArea} overlaps tag ${other.name}.`,
        { rule: "address-overlap", conflictsWith: other.name },
      );
    }
  }
}
