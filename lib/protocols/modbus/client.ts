import "server-only";
import { connect } from "node:net";
import { DomainError } from "@/lib/domain/errors";
import type { ModbusArea } from "@/lib/domain/tag";

/**
 * Minimal Modbus TCP client: the four read functions and the two single-write functions.
 * Addresses are zero-based within their area. Typed values, scaling and multi-word
 * encoding are layered on top of this by the mapping/codec work of TASK-203.
 */

const READ_FUNCTION: Record<ModbusArea, number> = {
  COIL: 0x01,
  DISCRETE_INPUT: 0x02,
  HOLDING_REGISTER: 0x03,
  INPUT_REGISTER: 0x04,
};

const TIMEOUT_MS = 3000;
const MAX_ADDRESS = 0xffff;

export type ModbusEndpoint = { host: string; port: number; unitId?: number };

const isBitArea = (area: ModbusArea) => area === "COIL" || area === "DISCRETE_INPUT";

function assertRange(address: number, count: number, area: ModbusArea): void {
  const maxCount = isBitArea(area) ? 2000 : 125;
  if (!Number.isInteger(address) || !Number.isInteger(count) || address < 0 || count < 1 || count > maxCount) {
    throw new DomainError("VALIDATION", "Invalid Modbus address or count.", { rule: "modbus-range" });
  }
  if (address + count - 1 > MAX_ADDRESS) {
    throw new DomainError("VALIDATION", "The Modbus range exceeds the address space.", { rule: "modbus-range" });
  }
}

/** One request/response exchange. Returns the response PDU (function code + data). */
function exchange(endpoint: ModbusEndpoint, pdu: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const header = Buffer.alloc(7);
    header.writeUInt16BE(1, 0); // transaction id
    header.writeUInt16BE(0, 2); // protocol id
    header.writeUInt16BE(pdu.length + 1, 4);
    header.writeUInt8(endpoint.unitId ?? 1, 6);

    const socket = connect({ host: endpoint.host, port: endpoint.port });
    const chunks: Buffer[] = [];
    const fail = (rule: string, message: string) => {
      socket.destroy();
      reject(new DomainError("RUNTIME_FAILURE", message, { rule }));
    };

    socket.setTimeout(TIMEOUT_MS, () => fail("modbus-timeout", "The Modbus server did not answer in time."));
    socket.on("error", () => fail("modbus-unreachable", "The Modbus server is not reachable."));
    socket.on("connect", () => socket.write(Buffer.concat([header, pdu])));
    socket.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      if (data.length < 7) return;
      const length = data.readUInt16BE(4);
      if (data.length < 6 + length) return;
      socket.end();
      resolve(data.subarray(7, 6 + length));
    });
  });
}

function assertResponse(response: Buffer, functionCode: number): void {
  const code = response[0];
  if (code === (functionCode | 0x80)) {
    throw new DomainError("RUNTIME_FAILURE", "The Modbus server rejected the request.", {
      rule: "modbus-exception",
      exceptionCode: response[1],
    });
  }
  if (code !== functionCode) {
    throw new DomainError("RUNTIME_FAILURE", "Unexpected Modbus response.", { rule: "modbus-response" });
  }
}

/** Reads `count` values starting at `address`: booleans for bit areas, 16-bit words for registers. */
export async function readModbus(
  endpoint: ModbusEndpoint,
  area: ModbusArea,
  address: number,
  count = 1,
): Promise<Array<number | boolean>> {
  assertRange(address, count, area);
  const functionCode = READ_FUNCTION[area];
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);

  const response = await exchange(endpoint, pdu);
  assertResponse(response, functionCode);
  const data = response.subarray(2);

  if (isBitArea(area)) {
    return Array.from({ length: count }, (_, index) => ((data[index >> 3] ?? 0) & (1 << (index & 7))) !== 0);
  }
  return Array.from({ length: count }, (_, index) => data.readUInt16BE(index * 2));
}

/**
 * Writes one coil or one holding register. Discrete inputs and input registers are
 * read-only areas and are refused before anything is sent.
 */
export async function writeModbus(
  endpoint: ModbusEndpoint,
  area: ModbusArea,
  address: number,
  value: number | boolean,
): Promise<void> {
  assertRange(address, 1, area);
  if (area !== "COIL" && area !== "HOLDING_REGISTER") {
    throw new DomainError("INCOMPATIBLE", `Modbus area ${area} is read-only.`, { rule: "writable-area" });
  }
  const functionCode = area === "COIL" ? 0x05 : 0x06;
  const pdu = Buffer.alloc(5);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address, 1);
  if (area === "COIL") {
    pdu.writeUInt16BE(value ? 0xff00 : 0x0000, 3);
  } else {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 0xffff) {
      throw new DomainError("VALIDATION", "A holding register takes an integer from 0 to 65535.", {
        rule: "modbus-value",
      });
    }
    pdu.writeUInt16BE(value, 3);
  }
  assertResponse(await exchange(endpoint, pdu), functionCode);
}

/** Writes consecutive holding registers in one request (function 16), for multi-word values. */
export async function writeModbusRegisters(
  endpoint: ModbusEndpoint,
  address: number,
  words: readonly number[],
): Promise<void> {
  assertRange(address, Math.max(words.length, 1), "HOLDING_REGISTER");
  if (
    words.length < 1 ||
    words.length > 123 ||
    words.some((word) => !Number.isInteger(word) || word < 0 || word > 0xffff)
  ) {
    throw new DomainError("VALIDATION", "Holding registers take 1 to 123 integers from 0 to 65535.", {
      rule: "modbus-value",
    });
  }
  const functionCode = 0x10;
  const pdu = Buffer.alloc(6 + words.length * 2);
  pdu.writeUInt8(functionCode, 0);
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(words.length, 3);
  pdu.writeUInt8(words.length * 2, 5);
  words.forEach((word, index) => pdu.writeUInt16BE(word, 6 + index * 2));
  assertResponse(await exchange(endpoint, pdu), functionCode);
}
