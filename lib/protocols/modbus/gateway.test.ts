// @vitest-environment node
import { connect } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import { decideGatewayRead, decideGatewayWrite, type GatewayRegister } from "@/lib/domain/gateway";
import type { ModbusArea } from "@/lib/domain/tag";
import { readModbus, writeModbus, writeModbusRegisters } from "@/lib/protocols/modbus/client";
import {
  createModbusServer,
  MODBUS_EXCEPTION,
  ModbusException,
  type ModbusServer,
} from "@/lib/protocols/modbus/server";
import {
  type GatewayBackend,
  type GatewayEndpointSpec,
  GatewayEndpointRuntime,
} from "@/lib/runtimes/gateway-endpoint/runtime";

/**
 * What a gateway may read and write, the Modbus TCP server it talks to, and the endpoint
 * that puts the two together: without a database and without a PLC.
 */

const register = (
  name: string,
  area: ModbusArea,
  address: number,
  options: { wordCount?: number; writable?: boolean } = {},
): GatewayRegister => ({
  tagId: `tag-${name}`,
  name,
  externalName: name,
  area,
  address,
  wordCount: options.wordCount ?? 1,
  writable: options.writable ?? false,
});

const MAP: GatewayRegister[] = [
  register("Start_Cmd", "COIL", 80, { writable: true }),
  register("Stop_Cmd", "COIL", 81, { writable: true }),
  register("Running", "COIL", 8192),
  register("Speed_SP", "HOLDING_REGISTER", 10, { writable: true }),
  register("Speed_Actual", "HOLDING_REGISTER", 1024),
  register("Flow_Total", "HOLDING_REGISTER", 2048, { wordCount: 2 }),
  register("Ramp_SP", "HOLDING_REGISTER", 2050, { wordCount: 2, writable: true }),
  register("Level", "INPUT_REGISTER", 3),
];

const names = (decision: ReturnType<typeof decideGatewayRead>) =>
  decision.allowed ? decision.registers.map((entry) => entry.name) : decision.rule;

describe("what a gateway may read", () => {
  it("allows a read of mapped addresses only", () => {
    expect(names(decideGatewayRead(MAP, "COIL", 80, 1))).toEqual(["Start_Cmd"]);
    expect(names(decideGatewayRead(MAP, "COIL", 80, 2))).toEqual(["Start_Cmd", "Stop_Cmd"]);
    expect(names(decideGatewayRead(MAP, "HOLDING_REGISTER", 2048, 4))).toEqual(["Flow_Total", "Ramp_SP"]);
    expect(names(decideGatewayRead(MAP, "INPUT_REGISTER", 3, 1))).toEqual(["Level"]);
    // One word of a two-word value may be read: reading reveals nothing more than the value.
    expect(names(decideGatewayRead(MAP, "HOLDING_REGISTER", 2049, 1))).toEqual(["Flow_Total"]);
  });

  it("refuses an address that is not mapped, also when mapped ones are next to it", () => {
    expect(names(decideGatewayRead(MAP, "COIL", 79, 2))).toBe("gateway-unmapped");
    expect(names(decideGatewayRead(MAP, "COIL", 80, 3))).toBe("gateway-unmapped");
    // The registers between two mapped tags are not handed out with them.
    expect(names(decideGatewayRead(MAP, "HOLDING_REGISTER", 10, 1015))).toBe("gateway-unmapped");
    expect(names(decideGatewayRead(MAP, "HOLDING_REGISTER", 0, 1))).toBe("gateway-unmapped");
    // The same address in another area is another register.
    expect(names(decideGatewayRead(MAP, "DISCRETE_INPUT", 80, 1))).toBe("gateway-unmapped");
    expect(names(decideGatewayRead(MAP, "INPUT_REGISTER", 10, 1))).toBe("gateway-unmapped");
    expect(names(decideGatewayRead(MAP, "COIL", 80, 0))).toBe("gateway-unmapped");
    expect(names(decideGatewayRead([], "COIL", 0, 1))).toBe("gateway-unmapped");
  });
});

describe("what a gateway may write", () => {
  it("allows a write of whole values mapped as writable", () => {
    expect(names(decideGatewayWrite(MAP, "COIL", 80, 1))).toEqual(["Start_Cmd"]);
    expect(names(decideGatewayWrite(MAP, "COIL", 80, 2))).toEqual(["Start_Cmd", "Stop_Cmd"]);
    expect(names(decideGatewayWrite(MAP, "HOLDING_REGISTER", 10, 1))).toEqual(["Speed_SP"]);
    expect(names(decideGatewayWrite(MAP, "HOLDING_REGISTER", 2050, 2))).toEqual(["Ramp_SP"]);
  });

  it("refuses what PLC logic produces, whatever is written with it", () => {
    const refused = (area: ModbusArea, address: number, count: number) => {
      const decision = decideGatewayWrite(MAP, area, address, count);
      return decision.allowed ? "allowed" : [decision.rule, decision.register?.name];
    };
    expect(refused("COIL", 8192, 1)).toEqual(["gateway-read-only", "Running"]);
    expect(refused("HOLDING_REGISTER", 1024, 1)).toEqual(["gateway-read-only", "Speed_Actual"]);
    // A writable value in the same request does not carry a read-only one through.
    expect(refused("HOLDING_REGISTER", 2048, 4)).toEqual(["gateway-read-only", "Flow_Total"]);
    expect(refused("COIL", 82, 1)).toEqual(["gateway-unmapped", undefined]);
    expect(refused("COIL", 80, 3)).toEqual(["gateway-unmapped", undefined]);
    expect(refused("HOLDING_REGISTER", 0, 1)).toEqual(["gateway-unmapped", undefined]);
    // Half of a two-word setpoint would leave the PLC with a value nobody sent.
    expect(refused("HOLDING_REGISTER", 2050, 1)).toEqual(["gateway-partial-value", "Ramp_SP"]);
    expect(refused("HOLDING_REGISTER", 2051, 1)).toEqual(["gateway-partial-value", "Ramp_SP"]);
  });
});

/** Sends raw bytes and returns what comes back, or `closed` when the server hangs up. */
function exchange(port: number, bytes: number[]): Promise<number[] | "closed"> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    socket.on("connect", () => socket.write(Buffer.from(bytes)));
    socket.on("data", (data) => {
      resolve([...data]);
      socket.destroy();
    });
    socket.on("close", () => resolve("closed"));
    socket.on("error", () => resolve("closed"));
  });
}

const frame = (unitId: number, pdu: number[], transaction = 7) => [
  transaction >> 8,
  transaction & 0xff,
  0,
  0,
  (pdu.length + 1) >> 8,
  (pdu.length + 1) & 0xff,
  unitId,
  ...pdu,
];

describe("the Modbus TCP server a gateway talks to", () => {
  let server: ModbusServer;
  const coils = new Array<boolean>(100).fill(false);
  const holding = new Array<number>(100).fill(0);
  const calls: string[] = [];
  const clients: string[] = [];

  const start = async (options: { maxClients?: number; idleMs?: number } = {}) => {
    calls.length = 0;
    clients.length = 0;
    server = createModbusServer({
      unitId: 5,
      ...options,
      onClient: (event) => clients.push(event),
      handler: {
        async read(area, address, count) {
          calls.push(`read ${area} ${address} ${count}`);
          if (address >= 90) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
          if (address === 50) throw new Error("the backend broke");
          const source = area === "COIL" || area === "DISCRETE_INPUT" ? coils : holding;
          return source.slice(address, address + count);
        },
        async write(area, address, values) {
          calls.push(`write ${area} ${address} ${values.join(",")}`);
          if (address >= 90) throw new ModbusException(MODBUS_EXCEPTION.ILLEGAL_DATA_ADDRESS);
          values.forEach((value, index) => {
            if (area === "COIL") coils[address + index] = value === true;
            else holding[address + index] = Number(value);
          });
        },
      },
    });
    await server.listen("127.0.0.1", 0);
    return { host: "127.0.0.1", port: server.port() ?? 0, unitId: 5 };
  };
  afterEach(async () => {
    await server?.close();
  });

  it("answers the client the application itself uses", async () => {
    const endpoint = await start();
    coils.fill(false);
    holding.fill(0);
    await writeModbus(endpoint, "COIL", 3, true);
    await writeModbus(endpoint, "HOLDING_REGISTER", 7, 1234);
    await writeModbusRegisters(endpoint, 20, [0x1234, 0xabcd]);

    expect(await readModbus(endpoint, "COIL", 2, 3)).toEqual([false, true, false]);
    expect(await readModbus(endpoint, "DISCRETE_INPUT", 3, 1)).toEqual([true]);
    expect(await readModbus(endpoint, "HOLDING_REGISTER", 7, 1)).toEqual([1234]);
    expect(await readModbus(endpoint, "INPUT_REGISTER", 20, 2)).toEqual([0x1234, 0xabcd]);
    expect(calls).toEqual([
      "write COIL 3 true",
      "write HOLDING_REGISTER 7 1234",
      "write HOLDING_REGISTER 20 4660,43981",
      "read COIL 2 3",
      "read DISCRETE_INPUT 3 1",
      "read HOLDING_REGISTER 7 1",
      "read INPUT_REGISTER 20 2",
    ]);
  });

  it("answers what the handler refuses, and what breaks, with a Modbus exception", async () => {
    const endpoint = await start();
    const refused = await readModbus(endpoint, "HOLDING_REGISTER", 95, 1).catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DomainError);
    expect(await exchange(endpoint.port, frame(5, [0x03, 0, 95, 0, 1]))).toEqual([0, 7, 0, 0, 0, 3, 5, 0x83, 0x02]);
    expect(await exchange(endpoint.port, frame(5, [0x06, 0, 95, 0, 1]))).toEqual([0, 7, 0, 0, 0, 3, 5, 0x86, 0x02]);
    // A failure inside the handler says nothing about itself.
    expect(await exchange(endpoint.port, frame(5, [0x03, 0, 50, 0, 1]))).toEqual([0, 7, 0, 0, 0, 3, 5, 0x83, 0x04]);
  });

  it("checks every request before the handler sees it", async () => {
    const { port } = await start();
    const reply = async (pdu: number[], unitId = 5) => {
      const answer = await exchange(port, frame(unitId, pdu));
      return answer === "closed" ? answer : answer.slice(7);
    };
    // Another unit id is not this server's to answer for.
    expect(await reply([0x03, 0, 0, 0, 1], 1)).toEqual([0x83, 0x0a]);
    // Functions the server does not have: diagnostics, file records, mask write, read/write.
    for (const code of [0x07, 0x08, 0x14, 0x16, 0x17, 0x2b])
      expect(await reply([code, 0, 0, 0, 1])).toEqual([code | 0x80, 0x01]);
    // Quantities outside the protocol's limits.
    expect(await reply([0x03, 0, 0, 0, 0])).toEqual([0x83, 0x03]);
    expect(await reply([0x03, 0, 0, 0, 126])).toEqual([0x83, 0x03]);
    expect(await reply([0x01, 0, 0, 0x07, 0xd1])).toEqual([0x81, 0x03]);
    expect(await reply([0x03, 0xff, 0xff, 0, 2])).toEqual([0x83, 0x02]);
    // A coil is written as 0xFF00 or 0x0000 and nothing else.
    expect(await reply([0x05, 0, 1, 0x12, 0x34])).toEqual([0x85, 0x03]);
    // A length that does not match what the request says it carries.
    expect(await reply([0x10, 0, 1, 0, 2, 4, 0, 1])).toEqual([0x90, 0x03]);
    expect(await reply([0x10, 0, 1, 0, 2, 3, 0, 1, 0, 2])).toEqual([0x90, 0x03]);
    expect(await reply([0x0f, 0, 1, 0, 9, 1, 0xff])).toEqual([0x8f, 0x03]);
    expect(await reply([0x03, 0, 0])).toEqual([0x83, 0x03]);
    expect(calls).toEqual([]);

    expect(await reply([0x0f, 0, 10, 0, 3, 1, 0b101])).toEqual([0x0f, 0, 10, 0, 3]);
    expect(await reply([0x10, 0, 30, 0, 2, 4, 0, 5, 0, 6])).toEqual([0x10, 0, 30, 0, 2]);
    expect(calls).toEqual(["write COIL 10 true,false,true", "write HOLDING_REGISTER 30 5,6"]);
  });

  it("hangs up on what is not Modbus TCP", async () => {
    const { port } = await start();
    expect(await exchange(port, [...Buffer.from("GET / HTTP/1.1\r\nHost: plc\r\n\r\n")])).toBe("closed");
    // A protocol id other than 0, and a length no request can have.
    expect(await exchange(port, [0, 1, 0, 9, 0, 6, 5, 3, 0, 0, 0, 1])).toBe("closed");
    expect(await exchange(port, [0, 1, 0, 0, 0xff, 0xff, 5, 3, 0, 0, 0, 1])).toBe("closed");
    expect(await exchange(port, [0, 1, 0, 0, 0, 1, 5])).toBe("closed");
    expect(calls).toEqual([]);
  });

  it("keeps to its number of clients and tells who came and went", async () => {
    const { port } = await start({ maxClients: 1 });
    const first = connect({ host: "127.0.0.1", port });
    await new Promise((resolve) => first.on("connect", resolve));
    await expect.poll(() => server.clients()).toBe(1);
    // The second connection is closed at once; the first one keeps working.
    expect(await exchange(port, frame(5, [0x03, 0, 0, 0, 1]))).toBe("closed");
    const answered = new Promise<Buffer>((resolve) => first.once("data", resolve));
    first.write(Buffer.from(frame(5, [0x03, 0, 7, 0, 1])));
    expect([...(await answered)].slice(7, 9)).toEqual([0x03, 2]);
    first.destroy();
    await expect.poll(() => clients).toEqual(["connected", "disconnected"]);
  });

  it("closes a connection that says nothing", async () => {
    const { port } = await start({ idleMs: 40 });
    const socket = connect({ host: "127.0.0.1", port });
    const closed = new Promise((resolve) => socket.on("close", resolve));
    await closed;
    await expect.poll(() => server.clients()).toBe(0);
  });
});

describe("a gateway's endpoint", () => {
  const runtime = new GatewayEndpointRuntime();
  afterEach(() => runtime.stopAll());

  const spec = (overrides: Partial<GatewayEndpointSpec> = {}): GatewayEndpointSpec => ({
    connectionId: "connection-1",
    factoryId: "factory-1",
    gatewayDeviceId: "gateway-1",
    plcId: "plc-1",
    host: "127.0.0.1",
    port: 0,
    unitId: 1,
    registers: MAP,
    ...overrides,
  });

  function backend(plcAnswers = true) {
    const log: string[] = [];
    const implementation: GatewayBackend = {
      async read(_spec, area, address, count) {
        log.push(`read ${area} ${address} ${count}`);
        if (!plcAnswers)
          throw new DomainError("RUNTIME_FAILURE", "The PLC did not answer.", { rule: "modbus-unreachable" });
        return new Array<number>(count).fill(area === "COIL" ? 1 : 42).map((value) => (area === "COIL" ? true : value));
      },
      async write(_spec, target, raw) {
        log.push(`write ${target.name} ${raw.join(",")}`);
        if (target.name === "Speed_SP" && raw[0] === 9999) {
          throw new DomainError("VALIDATION", "The value is outside the tag's range.", { rule: "tag-range" });
        }
        if (!plcAnswers)
          throw new DomainError("RUNTIME_FAILURE", "The PLC did not answer.", { rule: "modbus-unreachable" });
      },
      async refused(_spec, refusal) {
        log.push(
          `refused ${refusal.rule} ${refusal.area} ${refusal.address} ${refusal.count} ${refusal.register?.name ?? "-"}`,
        );
      },
      client(_spec, event) {
        log.push(`client ${event}`);
      },
    };
    return { implementation, log };
  }

  const reach = (port: number) => ({ host: "127.0.0.1", port, unitId: 1 });
  const exceptionOf = async (action: Promise<unknown>) => {
    const error = await action.then(
      () => undefined,
      (reason: unknown) => reason,
    );
    return error instanceof DomainError ? error.details.exceptionCode : error;
  };

  it("passes on what the map allows and nothing else", async () => {
    const { implementation, log } = backend();
    expect(await runtime.ensure(spec(), implementation)).toMatchObject({ listening: true, error: null, requests: 0 });
    const endpoint = reach(runtime.port("connection-1") ?? 0);

    expect(await readModbus(endpoint, "COIL", 80, 2)).toEqual([true, true]);
    expect(await readModbus(endpoint, "HOLDING_REGISTER", 2048, 4)).toEqual([42, 42, 42, 42]);
    await writeModbus(endpoint, "COIL", 80, true);
    await writeModbusRegisters(endpoint, 2050, [1, 2]);

    expect(await exceptionOf(readModbus(endpoint, "HOLDING_REGISTER", 0, 1))).toBe(2);
    expect(await exceptionOf(readModbus(endpoint, "HOLDING_REGISTER", 10, 100))).toBe(2);
    expect(await exceptionOf(writeModbus(endpoint, "COIL", 8192, true))).toBe(2);
    expect(await exceptionOf(writeModbus(endpoint, "HOLDING_REGISTER", 1024, 7))).toBe(2);
    expect(await exceptionOf(writeModbus(endpoint, "HOLDING_REGISTER", 500, 7))).toBe(2);
    expect(await exceptionOf(writeModbus(endpoint, "HOLDING_REGISTER", 2050, 7))).toBe(2);

    // Refused requests never reach the PLC side; refused writes are reported.
    expect(log.filter((line) => !line.startsWith("client"))).toEqual([
      "read COIL 80 2",
      "read HOLDING_REGISTER 2048 4",
      "write Start_Cmd true",
      "write Ramp_SP 1,2",
      "refused gateway-read-only COIL 8192 1 Running",
      "refused gateway-read-only HOLDING_REGISTER 1024 1 Speed_Actual",
      "refused gateway-unmapped HOLDING_REGISTER 500 1 -",
      "refused gateway-partial-value HOLDING_REGISTER 2050 1 Ramp_SP",
    ]);
    expect(runtime.status("connection-1")).toMatchObject({ listening: true, requests: 10, refused: 6 });
    expect(runtime.status("connection-1").lastRequestAt).toMatch(/^\d{4}-/);
  });

  it("says that the PLC does not answer, and that a value was not accepted", async () => {
    const { implementation } = backend(false);
    await runtime.ensure(spec(), implementation);
    const endpoint = reach(runtime.port("connection-1") ?? 0);
    expect(await exceptionOf(readModbus(endpoint, "COIL", 80, 1))).toBe(MODBUS_EXCEPTION.GATEWAY_TARGET_FAILED);
    expect(await exceptionOf(writeModbus(endpoint, "COIL", 80, true))).toBe(MODBUS_EXCEPTION.GATEWAY_TARGET_FAILED);
    expect(await exceptionOf(writeModbus(endpoint, "HOLDING_REGISTER", 10, 9999))).toBe(
      MODBUS_EXCEPTION.ILLEGAL_DATA_VALUE,
    );
  });

  it("takes over a changed map at once and keeps the listener", async () => {
    const { implementation } = backend();
    // A port that is free: a configured endpoint always names its port.
    await runtime.ensure(spec({ connectionId: "probe" }), implementation);
    const port = runtime.port("probe") ?? 0;
    await runtime.stop("probe");
    await runtime.ensure(
      spec({ port, registers: [register("Start_Cmd", "COIL", 80, { writable: true })] }),
      implementation,
    );
    expect(await exceptionOf(readModbus(reach(port), "HOLDING_REGISTER", 10, 1))).toBe(2);

    await runtime.ensure(spec({ port, registers: MAP }), implementation);
    expect(runtime.port("connection-1")).toBe(port);
    expect(await readModbus(reach(port), "HOLDING_REGISTER", 10, 1)).toEqual([42]);
    // The earlier requests are still counted: it is the same endpoint.
    expect(runtime.status("connection-1").requests).toBe(2);

    await runtime.ensure(spec({ port, registers: [] }), implementation);
    expect(await exceptionOf(readModbus(reach(port), "COIL", 80, 1))).toBe(2);
  });

  it("tells a device's arrival and leaving once, however many connections it opens", async () => {
    const quick = new GatewayEndpointRuntime({ visitQuietMs: 60 });
    try {
      const { implementation, log } = backend();
      await quick.ensure(spec(), implementation);
      const endpoint = reach(quick.port("connection-1") ?? 0);
      // The application's client opens a connection per request, as many simple gateways do.
      for (let request = 0; request < 5; request += 1) await readModbus(endpoint, "COIL", 80, 1);
      const visits = () => log.filter((line) => line.startsWith("client"));
      expect(visits()).toEqual(["client connected"]);
      expect(quick.status("connection-1")).toMatchObject({ clients: 1, requests: 5 });

      await expect.poll(visits, { timeout: 2000 }).toEqual(["client connected", "client disconnected"]);
      expect(quick.status("connection-1").clients).toBe(0);
      // It comes back as a new visit; closing the endpoint ends a visit at once.
      await readModbus(endpoint, "COIL", 80, 1);
      await quick.stop("connection-1");
      expect(visits()).toEqual(["client connected", "client disconnected", "client connected", "client disconnected"]);
    } finally {
      await quick.stopAll();
    }
  });

  it("reports an address it cannot listen on and closes endpoints that are no longer wanted", async () => {
    const { implementation } = backend();
    await runtime.ensure(spec(), implementation);
    const port = runtime.port("connection-1") ?? 0;
    const second = await runtime.ensure(spec({ connectionId: "connection-2", port }), implementation);
    expect(second).toMatchObject({ listening: false, error: "The port is in use by another program on this host." });
    const elsewhere = await runtime.ensure(spec({ connectionId: "connection-3", host: "203.0.113.7" }), implementation);
    expect(elsewhere).toMatchObject({
      listening: false,
      error: "This host has no network interface with that address.",
    });

    await runtime.stopOthers("another-factory", new Set());
    expect(runtime.status("connection-1").listening).toBe(true);
    await runtime.stopOthers("factory-1", new Set(["connection-2"]));
    expect(runtime.status("connection-1")).toMatchObject({ listening: false, requests: 0 });
    expect(await exceptionOf(readModbus(reach(port), "COIL", 80, 1))).not.toBe(2);
  });
});
