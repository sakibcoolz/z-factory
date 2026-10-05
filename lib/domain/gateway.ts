/**
 * What an external gateway may do with a PLC's registers (docs/gateway-modbus.md,
 * ADR-0013). A gateway sees only the tags mapped to it, at the PLC's own Modbus
 * addresses, and may write only those mapped as writable. Pure rules; importable anywhere.
 */
import type { ModbusArea } from "@/lib/domain/tag";

/** One mapped tag as the gateway sees it. */
export type GatewayRegister = {
  tagId: string;
  /** The tag's name in the PLC. */
  name: string;
  /** The name the gateway knows it by. */
  externalName: string;
  area: ModbusArea;
  /** Zero-based address within its area. */
  address: number;
  /** Words for a register value, 1 for a bit. */
  wordCount: number;
  /** The mapping allows writing and the tag is a command or setpoint. */
  writable: boolean;
};

export type GatewayRefusal =
  /** The request touches an address that is not mapped to this gateway. */
  | "gateway-unmapped"
  /** The request would write a tag that is mapped for reading only. */
  | "gateway-read-only"
  /** The request would write only part of a value that spans several registers. */
  | "gateway-partial-value";

export type GatewayDecision =
  | { allowed: true; registers: GatewayRegister[] }
  | { allowed: false; rule: GatewayRefusal; register?: GatewayRegister };

const end = (register: GatewayRegister) => register.address + register.wordCount;

/** The mapped registers of one area that a range of addresses touches, in address order. */
function touched(map: readonly GatewayRegister[], area: ModbusArea, address: number, count: number) {
  return map
    .filter((register) => register.area === area && register.address < address + count && end(register) > address)
    .sort((a, b) => a.address - b.address);
}

/** True when every address of the range belongs to one of the registers. */
function covered(registers: readonly GatewayRegister[], address: number, count: number): boolean {
  let next = address;
  for (const register of registers) {
    if (register.address > next) return false;
    next = Math.max(next, end(register));
  }
  return next >= address + count;
}

/**
 * A read is allowed when every address it asks for is mapped. Addresses between two
 * mapped tags are not handed out with them: the gateway learns nothing it was not given.
 */
export function decideGatewayRead(
  map: readonly GatewayRegister[],
  area: ModbusArea,
  address: number,
  count: number,
): GatewayDecision {
  const registers = touched(map, area, address, count);
  return count > 0 && covered(registers, address, count)
    ? { allowed: true, registers }
    : { allowed: false, rule: "gateway-unmapped" };
}

/**
 * A write is allowed when it covers whole values only, each of them mapped as writable.
 * A write is refused as a whole: no part of a refused request reaches the PLC.
 */
export function decideGatewayWrite(
  map: readonly GatewayRegister[],
  area: ModbusArea,
  address: number,
  count: number,
): GatewayDecision {
  const registers = touched(map, area, address, count);
  if (count <= 0 || !covered(registers, address, count)) return { allowed: false, rule: "gateway-unmapped" };
  const readOnly = registers.find((register) => !register.writable);
  if (readOnly) return { allowed: false, rule: "gateway-read-only", register: readOnly };
  const partial = registers.find((register) => register.address < address || end(register) > address + count);
  if (partial) return { allowed: false, rule: "gateway-partial-value", register: partial };
  return { allowed: true, registers };
}

export const GATEWAY_REFUSAL_TEXT: Record<GatewayRefusal, string> = {
  "gateway-unmapped": "the address is not mapped to this gateway",
  "gateway-read-only": "the tag is mapped for reading only",
  "gateway-partial-value": "the write covers only part of a value",
};

/** Device categories that are gateways: the external devices this screen configures. */
export const GATEWAY_CATEGORY_CODES: readonly string[] = ["GATEWAY", "EDGE_GATEWAY"];
