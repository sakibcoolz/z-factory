import "server-only";
import { DomainError } from "@/lib/domain/errors";
import type { ModbusArea, TagDataType } from "@/lib/domain/tag";

/**
 * IEC 61131-3 located addresses and where the OpenPLC runtime exposes them over Modbus.
 * The runtime fixes this mapping (ADR-0009); Z-Factory derives Modbus addresses from
 * located addresses and never assigns them freely. Addresses are zero-based per area.
 */

export type LocatedRegion = "I" | "Q" | "M";
export type LocatedSize = "X" | "W" | "D";

export type LocatedAddress = {
  region: LocatedRegion;
  size: LocatedSize;
  index: number;
  /** Bit within the byte, for `X` addresses only. */
  bit: number | null;
};

export type ModbusLocation = { area: ModbusArea; address: number; wordCount: number };

/** Segment sizes of the runtime's Modbus server, as configured in `conf/modbus_slave.json`. */
export const MODBUS_LAYOUT = {
  bitBytes: 1024,
  qwCount: 1024,
  iwCount: 1024,
  mwCount: 1024,
  mdCount: 1024,
} as const;

const LOCATED = /^%([IQM])([XWD])(\d{1,5})(?:\.(\d))?$/;

const invalid = (message: string, rule: string) =>
  new DomainError("VALIDATION", message, { rule, field: "logicalAddress" });

export function parseLocatedAddress(text: string): LocatedAddress {
  const match = LOCATED.exec(text.trim().toUpperCase());
  if (!match) {
    throw invalid("Use a located address such as %IX0.0, %QX0.1, %IW3, %QW3, %MW10 or %MD4.", "located-syntax");
  }
  const [, region, size, indexText, bitText] = match as unknown as [
    string,
    LocatedRegion,
    LocatedSize,
    string,
    string?,
  ];
  const index = Number(indexText);

  if (size === "X") {
    if (bitText === undefined) throw invalid("A bit address needs a bit number, e.g. %QX0.1.", "located-bit");
    const bit = Number(bitText);
    if (bit > 7) throw invalid("The bit number must be 0 to 7.", "located-bit");
    if (index >= MODBUS_LAYOUT.bitBytes) throw invalid("The byte index is out of range.", "located-range");
    return { region, size, index, bit };
  }
  if (bitText !== undefined) throw invalid("Only bit (X) addresses take a bit number.", "located-bit");
  if (size === "D" && region !== "M") {
    // The runtime exposes 32-bit values over Modbus only from the %MD memory area.
    throw invalid("32-bit values must use the memory area, e.g. %MD4.", "located-double-word");
  }
  const limit =
    size === "D"
      ? MODBUS_LAYOUT.mdCount
      : region === "I"
        ? MODBUS_LAYOUT.iwCount
        : region === "Q"
          ? MODBUS_LAYOUT.qwCount
          : MODBUS_LAYOUT.mwCount;
  if (index >= limit) throw invalid("The address index is out of range.", "located-range");
  return { region, size, index, bit: null };
}

export function formatLocatedAddress(address: LocatedAddress): string {
  const bit = address.size === "X" ? `.${address.bit ?? 0}` : "";
  return `%${address.region}${address.size}${address.index}${bit}`;
}

/** The Modbus area and zero-based address the runtime serves a located address at. */
export function toModbusLocation(address: LocatedAddress): ModbusLocation {
  if (address.size === "X") {
    const bitIndex = address.index * 8 + (address.bit ?? 0);
    if (address.region === "I") return { area: "DISCRETE_INPUT", address: bitIndex, wordCount: 1 };
    // %MX bits follow the %QX bits in the coil area.
    const base = address.region === "Q" ? 0 : MODBUS_LAYOUT.bitBytes * 8;
    return { area: "COIL", address: base + bitIndex, wordCount: 1 };
  }
  if (address.size === "W") {
    if (address.region === "I") return { area: "INPUT_REGISTER", address: address.index, wordCount: 1 };
    const base = address.region === "Q" ? 0 : MODBUS_LAYOUT.qwCount;
    return { area: "HOLDING_REGISTER", address: base + address.index, wordCount: 1 };
  }
  // %MD: two registers per value, after the %QW and %MW segments.
  return {
    area: "HOLDING_REGISTER",
    address: MODBUS_LAYOUT.qwCount + MODBUS_LAYOUT.mwCount + address.index * 2,
    wordCount: 2,
  };
}

const TYPES_BY_SIZE: Record<LocatedSize, readonly TagDataType[]> = {
  X: ["BOOL"],
  W: ["INT16", "UINT16"],
  D: ["INT32", "UINT32", "FLOAT32"],
};

export function assertDataTypeFits(address: LocatedAddress, dataType: TagDataType): void {
  if (!TYPES_BY_SIZE[address.size].includes(dataType)) {
    throw new DomainError(
      "INCOMPATIBLE",
      `${dataType} does not fit ${formatLocatedAddress(address)}; use ${TYPES_BY_SIZE[address.size].join(" or ")}.`,
      { rule: "data-type-size", field: "dataType" },
    );
  }
}

const AREA_PREFIX: Record<ModbusArea, string> = {
  COIL: "0",
  DISCRETE_INPUT: "1",
  INPUT_REGISTER: "3",
  HOLDING_REGISTER: "4",
};

/**
 * Conventional one-based display notation (00001, 10001, 30001, 40001…). Derived for
 * people only; the stored address is always the area plus a zero-based number.
 */
export function modbusDisplayAddress(area: ModbusArea, address: number): string {
  const digits = address + 1 > 9999 ? 5 : 4;
  return `${AREA_PREFIX[area]}${String(address + 1).padStart(digits, "0")}`;
}
