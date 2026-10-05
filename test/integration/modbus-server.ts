import { createServer, type Server } from "node:net";

/**
 * A minimal Modbus TCP server standing in for a PLC in tests: coils and holding registers
 * with function codes 1, 3, 5, 6 and 16. It runs no logic; tests set what "PLC logic" drives.
 */
export type TestPlc = {
  port: number;
  coils: boolean[];
  holding: number[];
  close(): Promise<void>;
};

function respond(pdu: Buffer, plc: { coils: boolean[]; holding: number[] }): Buffer {
  const code = pdu.readUInt8(0);
  const address = pdu.readUInt16BE(1);
  switch (code) {
    case 0x01: {
      const count = pdu.readUInt16BE(3);
      const bytes = Buffer.alloc(Math.ceil(count / 8));
      for (let index = 0; index < count; index += 1) {
        if (plc.coils[address + index]) bytes[index >> 3] = (bytes[index >> 3] ?? 0) | (1 << (index & 7));
      }
      return Buffer.concat([Buffer.from([code, bytes.length]), bytes]);
    }
    case 0x03: {
      const count = pdu.readUInt16BE(3);
      const bytes = Buffer.alloc(count * 2);
      for (let index = 0; index < count; index += 1) bytes.writeUInt16BE(plc.holding[address + index] ?? 0, index * 2);
      return Buffer.concat([Buffer.from([code, bytes.length]), bytes]);
    }
    case 0x05:
      plc.coils[address] = pdu.readUInt16BE(3) === 0xff00;
      return pdu.subarray(0, 5);
    case 0x06:
      plc.holding[address] = pdu.readUInt16BE(3);
      return pdu.subarray(0, 5);
    case 0x10: {
      const count = pdu.readUInt16BE(3);
      for (let index = 0; index < count; index += 1) plc.holding[address + index] = pdu.readUInt16BE(6 + index * 2);
      return pdu.subarray(0, 5);
    }
    default:
      return Buffer.from([code | 0x80, 0x01]);
  }
}

export async function startTestPlc(): Promise<TestPlc> {
  const plc = { coils: new Array<boolean>(9000).fill(false), holding: new Array<number>(5000).fill(0) };
  const server: Server = createServer((socket) => {
    socket.on("error", () => socket.destroy());
    socket.on("data", (frame: Buffer) => {
      const response = respond(frame.subarray(7), plc);
      const header = Buffer.from(frame.subarray(0, 7));
      header.writeUInt16BE(response.length + 1, 4);
      socket.write(Buffer.concat([header, response]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("test PLC did not bind a port");
  return {
    port: address.port,
    ...plc,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
