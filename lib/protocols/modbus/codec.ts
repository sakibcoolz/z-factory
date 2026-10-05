import "server-only";
import { DomainError } from "@/lib/domain/errors";
import type { TagDataType } from "@/lib/domain/tag";

/**
 * Typed values ↔ 16-bit Modbus words. Data type, word count, byte order, word order and
 * scaling are always explicit; nothing here assumes a register layout.
 *
 * Engineering value = raw × scale + offset.
 */

export type ByteOrder = "BIG_ENDIAN" | "LITTLE_ENDIAN";
export type WordOrder = "HIGH_WORD_FIRST" | "LOW_WORD_FIRST";

export type Encoding = {
  dataType: TagDataType;
  byteOrder?: ByteOrder;
  wordOrder?: WordOrder;
  scale?: number;
  offset?: number;
};

const RANGE: Record<Exclude<TagDataType, "BOOL" | "FLOAT32">, readonly [number, number]> = {
  INT16: [-32768, 32767],
  UINT16: [0, 65535],
  INT32: [-2147483648, 2147483647],
  UINT32: [0, 4294967295],
};

/** Largest magnitude a 32-bit float holds. */
const FLOAT32_MAX = 3.4028234663852886e38;

/** The engineering values an encoding can carry, after scale and offset. BOOL has no range. */
export function engineeringRange(encoding: Encoding): readonly [number, number] {
  if (encoding.dataType === "BOOL") return [0, 1];
  const [min, max] = encoding.dataType === "FLOAT32" ? [-FLOAT32_MAX, FLOAT32_MAX] : RANGE[encoding.dataType];
  const scale = encoding.scale ?? 1;
  const offset = encoding.offset ?? 0;
  const a = min * scale + offset;
  const b = max * scale + offset;
  return a <= b ? [a, b] : [b, a];
}

const swapBytes = (word: number) => ((word & 0xff) << 8) | ((word >> 8) & 0xff);

/** Words as they travel on the wire for the given orders. */
function arrange(words: number[], encoding: Encoding): number[] {
  const ordered = encoding.wordOrder === "LOW_WORD_FIRST" ? [...words].reverse() : words;
  return encoding.byteOrder === "LITTLE_ENDIAN" ? ordered.map(swapBytes) : ordered;
}

const invalidValue = (message: string) => new DomainError("VALIDATION", message, { rule: "tag-value", field: "value" });

/** Decodes register words (or one coil state) into an engineering value. */
export function decodeValue(raw: ReadonlyArray<number | boolean>, encoding: Encoding): number | boolean {
  if (encoding.dataType === "BOOL") return Boolean(raw[0]);

  const words = arrange(raw.map(Number), encoding);
  const [first = 0, second = 0] = words;
  let value: number;
  switch (encoding.dataType) {
    case "UINT16":
      value = first;
      break;
    case "INT16":
      value = first > 0x7fff ? first - 0x10000 : first;
      break;
    case "UINT32":
      value = first * 0x10000 + second;
      break;
    case "INT32":
      value = (first * 0x10000 + second) | 0;
      break;
    case "FLOAT32": {
      const buffer = Buffer.alloc(4);
      buffer.writeUInt16BE(first, 0);
      buffer.writeUInt16BE(second, 2);
      value = buffer.readFloatBE(0);
      break;
    }
  }
  return value * (encoding.scale ?? 1) + (encoding.offset ?? 0);
}

/** Encodes an engineering value into register words (or one coil state), validating its range. */
export function encodeValue(value: unknown, encoding: Encoding): number[] | boolean {
  if (encoding.dataType === "BOOL") {
    if (typeof value !== "boolean") throw invalidValue("A BOOL tag takes true or false.");
    return value;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) throw invalidValue("The value must be a finite number.");
  const scale = encoding.scale ?? 1;
  if (scale === 0) throw invalidValue("A scale of zero cannot be written through.");
  const raw = (value - (encoding.offset ?? 0)) / scale;

  let words: number[];
  if (encoding.dataType === "FLOAT32") {
    const buffer = Buffer.alloc(4);
    buffer.writeFloatBE(raw, 0);
    if (!Number.isFinite(buffer.readFloatBE(0))) throw invalidValue("The value does not fit a 32-bit float.");
    words = [buffer.readUInt16BE(0), buffer.readUInt16BE(2)];
  } else {
    const integer = Math.round(raw);
    const [min, max] = RANGE[encoding.dataType];
    if (integer < min || integer > max) {
      throw invalidValue(`The value is outside the ${encoding.dataType} range after scaling.`);
    }
    const unsigned = integer < 0 ? integer + (encoding.dataType === "INT16" ? 0x10000 : 0x100000000) : integer;
    words =
      encoding.dataType === "INT16" || encoding.dataType === "UINT16"
        ? [unsigned]
        : [Math.floor(unsigned / 0x10000), unsigned % 0x10000];
  }
  return arrange(words, encoding);
}
