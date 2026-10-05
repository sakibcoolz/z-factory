import "server-only";
import { createServer, type Server, type Socket } from "node:net";
import type { ModbusArea } from "@/lib/domain/tag";

/**
 * A Modbus TCP server for clients outside Z-Factory (an edge gateway). It speaks the
 * protocol and nothing else: what a request may read or write is decided by the handler
 * it is given. Requests come from an untrusted network, so every length and count is
 * checked and a connection that breaks the framing is closed.
 */

/** Exception codes of the Modbus application protocol. */
export const MODBUS_EXCEPTION = {
  ILLEGAL_FUNCTION: 0x01,
  ILLEGAL_DATA_ADDRESS: 0x02,
  ILLEGAL_DATA_VALUE: 0x03,
  SERVER_DEVICE_FAILURE: 0x04,
  GATEWAY_PATH_UNAVAILABLE: 0x0a,
  GATEWAY_TARGET_FAILED: 0x0b,
} as const;

/** Thrown by a handler to answer a request with a Modbus exception. */
export class ModbusException extends Error {
  constructor(readonly code: number) {
    super(`Modbus exception ${code}`);
    this.name = "ModbusException";
  }
}

export type ModbusServerHandler = {
  /** Booleans for bit areas, 16-bit words for register areas. */
  read(area: ModbusArea, address: number, count: number): Promise<Array<number | boolean>>;
  write(area: "COIL" | "HOLDING_REGISTER", address: number, values: Array<number | boolean>): Promise<void>;
};

export type ModbusServerOptions = {
  /** The only unit id the server answers for. */
  unitId: number;
  handler: ModbusServerHandler;
  /** Further connections are refused. */
  maxClients?: number;
  /** A connection that sends nothing for this long is closed. */
  idleMs?: number;
  onClient?: (event: "connected" | "disconnected", remoteAddress: string) => void;
};

export type ModbusServer = {
  listen(host: string, port: number): Promise<void>;
  close(): Promise<void>;
  /** The port the server listens on; differs from the requested one only when that was 0. */
  port(): number | null;
  clients(): number;
};

const MBAP_BYTES = 7;
/** A Modbus TCP frame is at most 260 bytes: 7 of header and 253 of PDU. */
const MAX_PDU_BYTES = 253;
const READ_AREA: Record<number, ModbusArea> = {
  0x01: "COIL",
  0x02: "DISCRETE_INPUT",
  0x03: "HOLDING_REGISTER",
  0x04: "INPUT_REGISTER",
};
const MAX_READ_BITS = 2000;
const MAX_READ_REGISTERS = 125;
const MAX_WRITE_BITS = 1968;
const MAX_WRITE_REGISTERS = 123;
const ADDRESS_SPACE = 65_536;

const illegalValue = () => new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE);

function packBits(values: ReadonlyArray<number | boolean>): Buffer {
  const bytes = Buffer.alloc(Math.ceil(values.length / 8));
  values.forEach((value, index) => {
    if (value) bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
  });
  return bytes;
}

async function answer(pdu: Buffer, handler: ModbusServerHandler): Promise<Buffer> {
  const code = pdu.readUInt8(0);
  const readArea = READ_AREA[code];
  if (readArea) {
    if (pdu.length !== 5) throw illegalValue();
    const address = pdu.readUInt16BE(1);
    const count = pdu.readUInt16BE(3);
    const bits = readArea === "COIL" || readArea === "DISCRETE_INPUT";
    if (count < 1 || count > (bits ? MAX_READ_BITS : MAX_READ_REGISTERS)) throw illegalValue();
    if (address + count > ADDRESS_SPACE) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
    const values = await handler.read(readArea, address, count);
    if (values.length !== count) throw new ModbusException(MODBUS_EXCEPTION.SERVER_DEVICE_FAILURE);
    if (bits) {
      const bytes = packBits(values);
      return Buffer.concat([Buffer.from([code, bytes.length]), bytes]);
    }
    const bytes = Buffer.alloc(count * 2);
    values.forEach((value, index) => bytes.writeUInt16BE(Number(value) & 0xffff, index * 2));
    return Buffer.concat([Buffer.from([code, bytes.length]), bytes]);
  }

  switch (code) {
    case 0x05: {
      if (pdu.length !== 5) throw illegalValue();
      const raw = pdu.readUInt16BE(3);
      if (raw !== 0xff00 && raw !== 0x0000) throw illegalValue();
      await handler.write("COIL", pdu.readUInt16BE(1), [raw === 0xff00]);
      return pdu;
    }
    case 0x06: {
      if (pdu.length !== 5) throw illegalValue();
      await handler.write("HOLDING_REGISTER", pdu.readUInt16BE(1), [pdu.readUInt16BE(3)]);
      return pdu;
    }
    case 0x0f: {
      if (pdu.length < 6) throw illegalValue();
      const address = pdu.readUInt16BE(1);
      const count = pdu.readUInt16BE(3);
      const byteCount = pdu.readUInt8(5);
      if (count < 1 || count > MAX_WRITE_BITS || byteCount !== Math.ceil(count / 8) || pdu.length !== 6 + byteCount) {
        throw illegalValue();
      }
      if (address + count > ADDRESS_SPACE) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
      const values = Array.from(
        { length: count },
        (_, index) => ((pdu[6 + (index >> 3)] ?? 0) & (1 << (index & 7))) !== 0,
      );
      await handler.write("COIL", address, values);
      return pdu.subarray(0, 5);
    }
    case 0x10: {
      if (pdu.length < 6) throw illegalValue();
      const address = pdu.readUInt16BE(1);
      const count = pdu.readUInt16BE(3);
      const byteCount = pdu.readUInt8(5);
      if (count < 1 || count > MAX_WRITE_REGISTERS || byteCount !== count * 2 || pdu.length !== 6 + byteCount) {
        throw illegalValue();
      }
      if (address + count > ADDRESS_SPACE) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
      const values = Array.from({ length: count }, (_, index) => pdu.readUInt16BE(6 + index * 2));
      await handler.write("HOLDING_REGISTER", address, values);
      return pdu.subarray(0, 5);
    }
    default:
      throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_FUNCTION);
  }
}

export function createModbusServer(options: ModbusServerOptions): ModbusServer {
  const maxClients = options.maxClients ?? 4;
  const idleMs = options.idleMs ?? 120_000;
  const sockets = new Set<Socket>();
  let server: Server | null = null;

  const serve = (socket: Socket) => {
    if (sockets.size >= maxClients) {
      socket.destroy();
      return;
    }
    const remote = socket.remoteAddress ?? "unknown";
    sockets.add(socket);
    options.onClient?.("connected", remote);
    socket.setNoDelay(true);
    socket.setTimeout(idleMs, () => socket.destroy());

    let buffer = Buffer.alloc(0);
    // Requests of one connection are answered in the order they arrived.
    let queue: Promise<void> = Promise.resolve();

    const respond = async (header: Buffer, pdu: Buffer) => {
      let body: Buffer;
      if (header.readUInt8(6) !== options.unitId) {
        body = Buffer.from([pdu.readUInt8(0) | 0x80, MODBUS_EXCEPTION.GATEWAY_PATH_UNAVAILABLE]);
      } else {
        try {
          body = await answer(pdu, options.handler);
        } catch (error) {
          const code = error instanceof ModbusException ? error.code : MODBUS_EXCEPTION.SERVER_DEVICE_FAILURE;
          body = Buffer.from([pdu.readUInt8(0) | 0x80, code]);
        }
      }
      const reply = Buffer.alloc(MBAP_BYTES);
      header.copy(reply, 0, 0, 4);
      reply.writeUInt16BE(body.length + 1, 4);
      reply.writeUInt8(header.readUInt8(6), 6);
      if (!socket.destroyed) socket.write(Buffer.concat([reply, body]));
    };

    socket.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= MBAP_BYTES) {
        const length = buffer.readUInt16BE(4);
        // Not Modbus TCP, or a frame no request can have: the connection is not a gateway's.
        if (buffer.readUInt16BE(2) !== 0 || length < 2 || length > MAX_PDU_BYTES + 1) {
          socket.destroy();
          return;
        }
        if (buffer.length < 6 + length) break;
        const header = buffer.subarray(0, MBAP_BYTES);
        const pdu = buffer.subarray(MBAP_BYTES, 6 + length);
        buffer = buffer.subarray(6 + length);
        queue = queue
          .then(() => respond(Buffer.from(header), Buffer.from(pdu)))
          .catch(() => {
            socket.destroy();
          });
      }
      // More than one full frame waiting without a complete header is not a client worth keeping.
      if (buffer.length > MBAP_BYTES + MAX_PDU_BYTES) socket.destroy();
    });
    socket.on("error", () => socket.destroy());
    socket.on("close", () => {
      if (sockets.delete(socket)) options.onClient?.("disconnected", remote);
    });
  };

  return {
    listen(host, port) {
      return new Promise<void>((resolve, reject) => {
        const created = createServer(serve);
        created.once("error", reject);
        created.listen({ host, port, exclusive: true }, () => {
          created.off("error", reject);
          created.on("error", () => undefined);
          server = created;
          resolve();
        });
      });
    },
    async close() {
      const current = server;
      server = null;
      for (const socket of sockets) socket.destroy();
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()));
    },
    port() {
      const address = server?.address();
      return address && typeof address === "object" ? address.port : null;
    },
    clients: () => sockets.size,
  };
}
