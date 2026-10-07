import { createServer, type Server, type Socket } from "node:net";

/**
 * A minimal Modbus TCP server standing in for a PLC in the end-to-end tests (TASK-903):
 * coils, discrete inputs, holding and input registers, read (functions 1-4) and written
 * (5, 6, 15, 16). Values are whatever the test sets.
 */
export class ModbusServer {
  readonly coils = new Map<number, boolean>();
  readonly registers = new Map<number, number>();
  private server: Server | undefined;
  private readonly sockets = new Set<Socket>();

  async listen(port: number): Promise<void> {
    this.server = createServer((socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => {});
      let pending = Buffer.alloc(0);
      socket.on("data", (chunk: Buffer) => {
        pending = Buffer.concat([pending, chunk]);
        while (pending.length >= 7) {
          const length = pending.readUInt16BE(4);
          if (pending.length < 6 + length) break;
          const frame = pending.subarray(0, 6 + length);
          pending = pending.subarray(6 + length);
          socket.write(this.answer(frame));
        }
      });
    });
    await new Promise<void>((done) => this.server!.listen(port, "127.0.0.1", done));
  }

  private answer(frame: Buffer): Buffer {
    const header = frame.subarray(0, 7);
    const pdu = frame.subarray(7);
    const fn = pdu[0]!;
    const start = pdu.readUInt16BE(1);
    const reply = (body: Buffer) => {
      const out = Buffer.alloc(7 + body.length);
      header.copy(out, 0, 0, 7);
      out.writeUInt16BE(1 + body.length, 4);
      body.copy(out, 7);
      return out;
    };
    if (fn === 1 || fn === 2) {
      const count = pdu.readUInt16BE(3);
      const bytes = Buffer.alloc(Math.ceil(count / 8));
      for (let index = 0; index < count; index += 1) {
        if (this.coils.get(start + index)) bytes[index >> 3]! |= 1 << (index & 7);
      }
      return reply(Buffer.concat([Buffer.from([fn, bytes.length]), bytes]));
    }
    if (fn === 3 || fn === 4) {
      const count = pdu.readUInt16BE(3);
      const words = Buffer.alloc(count * 2);
      for (let index = 0; index < count; index += 1)
        words.writeUInt16BE((this.registers.get(start + index) ?? 0) & 0xffff, index * 2);
      return reply(Buffer.concat([Buffer.from([fn, words.length]), words]));
    }
    if (fn === 5) {
      this.coils.set(start, pdu.readUInt16BE(3) === 0xff00);
      return reply(pdu.subarray(0, 5));
    }
    if (fn === 6) {
      this.registers.set(start, pdu.readUInt16BE(3));
      return reply(pdu.subarray(0, 5));
    }
    if (fn === 15 || fn === 16) return reply(pdu.subarray(0, 5));
    return reply(Buffer.from([fn | 0x80, 1]));
  }

  async close(): Promise<void> {
    for (const socket of this.sockets) socket.destroy();
    await new Promise<void>((done) => (this.server ? this.server.close(() => done()) : done()));
    this.server = undefined;
  }
}
