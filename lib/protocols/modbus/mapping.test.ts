// @vitest-environment node
import { createServer, type Server } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import { writeModbusRegisters } from "./client";
import { decodeValue, encodeValue } from "./codec";
import {
  assertDataTypeFits,
  formatLocatedAddress,
  modbusDisplayAddress,
  parseLocatedAddress,
  toModbusLocation,
} from "./located-address";

function expectDomainError(action: () => unknown, code: DomainErrorCode, rule?: string) {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(DomainError);
    expect((error as DomainError).code).toBe(code);
    if (rule) expect((error as DomainError).details.rule).toBe(rule);
    return;
  }
  expect.unreachable("expected a DomainError");
}

describe("located address to Modbus mapping", () => {
  it.each([
    ["%QX0.0", "COIL", 0, 1],
    ["%QX1.3", "COIL", 11, 1],
    ["%MX0.0", "COIL", 8192, 1],
    ["%IX0.0", "DISCRETE_INPUT", 0, 1],
    ["%IX2.7", "DISCRETE_INPUT", 23, 1],
    ["%IW5", "INPUT_REGISTER", 5, 1],
    ["%QW5", "HOLDING_REGISTER", 5, 1],
    ["%MW0", "HOLDING_REGISTER", 1024, 1],
    ["%MW10", "HOLDING_REGISTER", 1034, 1],
    ["%MD0", "HOLDING_REGISTER", 2048, 2],
    ["%MD3", "HOLDING_REGISTER", 2054, 2],
  ] as const)("%s is served at %s %i (%i word)", (text, area, address, wordCount) => {
    expect(toModbusLocation(parseLocatedAddress(text))).toEqual({ area, address, wordCount });
  });

  it("is deterministic and normalizes how an address is written", () => {
    expect(formatLocatedAddress(parseLocatedAddress(" %qx0.1 "))).toBe("%QX0.1");
    expect(toModbusLocation(parseLocatedAddress("%qw7"))).toEqual(toModbusLocation(parseLocatedAddress("%QW7")));
  });

  it("rejects malformed, unsupported and out-of-range addresses", () => {
    for (const text of ["QX0.0", "%QX0", "%QX0.8", "%QW1.0", "%ZW1", "%QB1", "%ML0", "%QW", "%QW-1", ""]) {
      expectDomainError(() => parseLocatedAddress(text), "VALIDATION");
    }
    expectDomainError(() => parseLocatedAddress("%QW1024"), "VALIDATION", "located-range");
    expectDomainError(() => parseLocatedAddress("%QX1024.0"), "VALIDATION", "located-range");
    expectDomainError(() => parseLocatedAddress("%MD1024"), "VALIDATION", "located-range");
    // 32-bit input/output words are not exposed by the runtime's Modbus server.
    expectDomainError(() => parseLocatedAddress("%QD0"), "VALIDATION", "located-double-word");
    expectDomainError(() => parseLocatedAddress("%ID0"), "VALIDATION", "located-double-word");
  });

  it("only accepts data types that fit the address size", () => {
    expect(() => assertDataTypeFits(parseLocatedAddress("%QX0.0"), "BOOL")).not.toThrow();
    expect(() => assertDataTypeFits(parseLocatedAddress("%QW0"), "UINT16")).not.toThrow();
    expect(() => assertDataTypeFits(parseLocatedAddress("%MD0"), "FLOAT32")).not.toThrow();
    expectDomainError(
      () => assertDataTypeFits(parseLocatedAddress("%QW0"), "FLOAT32"),
      "INCOMPATIBLE",
      "data-type-size",
    );
    expectDomainError(
      () => assertDataTypeFits(parseLocatedAddress("%QX0.0"), "INT16"),
      "INCOMPATIBLE",
      "data-type-size",
    );
    expectDomainError(() => assertDataTypeFits(parseLocatedAddress("%MD0"), "BOOL"), "INCOMPATIBLE", "data-type-size");
  });

  it("derives one-based display notation without storing it", () => {
    expect(modbusDisplayAddress("COIL", 0)).toBe("00001");
    expect(modbusDisplayAddress("DISCRETE_INPUT", 1)).toBe("10002");
    expect(modbusDisplayAddress("INPUT_REGISTER", 4)).toBe("30005");
    expect(modbusDisplayAddress("HOLDING_REGISTER", 1)).toBe("40002");
    expect(modbusDisplayAddress("HOLDING_REGISTER", 2048)).toBe("42049");
    // Beyond 9999 the six-digit form is used.
    expect(modbusDisplayAddress("HOLDING_REGISTER", 9999)).toBe("410000");
    expect(modbusDisplayAddress("HOLDING_REGISTER", 65535)).toBe("465536");
  });
});

describe("typed codecs", () => {
  it("round-trips every data type through its register words", () => {
    const cases = [
      ["BOOL", true],
      ["BOOL", false],
      ["UINT16", 65535],
      ["INT16", -32768],
      ["INT16", 1234],
      ["UINT32", 4294967295],
      ["INT32", -2147483648],
      ["INT32", 70000],
    ] as const;
    for (const [dataType, value] of cases) {
      const encoded = encodeValue(value, { dataType });
      const raw = typeof encoded === "boolean" ? [encoded] : encoded;
      expect(decodeValue(raw, { dataType }), `${dataType} ${value}`).toBe(value);
    }
    const float = encodeValue(3.25, { dataType: "FLOAT32" }) as number[];
    expect(float).toEqual([0x4050, 0x0000]);
    expect(decodeValue(float, { dataType: "FLOAT32" })).toBe(3.25);
  });

  it("puts the high word first by default and honours word and byte order", () => {
    const value = 0x12345678;
    expect(encodeValue(value, { dataType: "UINT32" })).toEqual([0x1234, 0x5678]);
    expect(encodeValue(value, { dataType: "UINT32", wordOrder: "LOW_WORD_FIRST" })).toEqual([0x5678, 0x1234]);
    expect(encodeValue(value, { dataType: "UINT32", byteOrder: "LITTLE_ENDIAN" })).toEqual([0x3412, 0x7856]);
    expect(encodeValue(value, { dataType: "UINT32", byteOrder: "LITTLE_ENDIAN", wordOrder: "LOW_WORD_FIRST" })).toEqual(
      [0x7856, 0x3412],
    );

    for (const wordOrder of ["HIGH_WORD_FIRST", "LOW_WORD_FIRST"] as const) {
      for (const byteOrder of ["BIG_ENDIAN", "LITTLE_ENDIAN"] as const) {
        const encoding = { dataType: "FLOAT32" as const, wordOrder, byteOrder };
        expect(decodeValue(encodeValue(-12.5, encoding) as number[], encoding)).toBe(-12.5);
      }
    }
    expect(decodeValue([0x3412], { dataType: "UINT16", byteOrder: "LITTLE_ENDIAN" })).toBe(0x1234);
  });

  it("applies scale and offset in both directions", () => {
    // Raw 450 with scale 0.1 is 45.0 Hz.
    expect(decodeValue([450], { dataType: "INT16", scale: 0.1 })).toBeCloseTo(45);
    expect(encodeValue(45, { dataType: "INT16", scale: 0.1 })).toEqual([450]);
    // 4–20 mA style: engineering = raw × 0.01 + 4.
    expect(decodeValue([1600], { dataType: "UINT16", scale: 0.01, offset: 4 })).toBeCloseTo(20);
    expect(encodeValue(20, { dataType: "UINT16", scale: 0.01, offset: 4 })).toEqual([1600]);
    // Negative raw values use two's complement.
    expect(encodeValue(-1, { dataType: "INT16" })).toEqual([0xffff]);
  });

  it("rejects values of the wrong type or outside the range", () => {
    expectDomainError(() => encodeValue(1, { dataType: "BOOL" }), "VALIDATION", "tag-value");
    expectDomainError(() => encodeValue(true, { dataType: "INT16" }), "VALIDATION", "tag-value");
    expectDomainError(() => encodeValue(Number.NaN, { dataType: "FLOAT32" }), "VALIDATION", "tag-value");
    expectDomainError(() => encodeValue(40000, { dataType: "INT16" }), "VALIDATION", "tag-value");
    expectDomainError(() => encodeValue(-1, { dataType: "UINT16" }), "VALIDATION", "tag-value");
    // In range as an engineering value, out of range once scaled back to raw.
    expectDomainError(() => encodeValue(7000, { dataType: "INT16", scale: 0.1 }), "VALIDATION", "tag-value");
    expectDomainError(() => encodeValue(1e39, { dataType: "FLOAT32" }), "VALIDATION", "tag-value");
  });
});

describe("multi-register write", () => {
  let server: Server | undefined;
  afterEach(() => {
    server?.close();
    server = undefined;
  });

  it("writes consecutive holding registers with function 16", async () => {
    const requests: Buffer[] = [];
    server = createServer((socket) => {
      socket.on("data", (data: Buffer) => {
        requests.push(data.subarray(7));
        const response = Buffer.concat([data.subarray(0, 4), Buffer.from([0x00, 0x06]), data.subarray(6, 12)]);
        socket.end(response);
      });
    });
    await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address ? address.port : 0;

    await writeModbusRegisters({ host: "127.0.0.1", port }, 2048, [0x4050, 0x0000]);

    expect(requests[0]).toEqual(Buffer.from([0x10, 0x08, 0x00, 0x00, 0x02, 0x04, 0x40, 0x50, 0x00, 0x00]));
  });

  it("validates the words before connecting", async () => {
    const endpoint = { host: "127.0.0.1", port: 9 };
    await expect(writeModbusRegisters(endpoint, 0, [])).rejects.toMatchObject({ code: "VALIDATION" });
    await expect(writeModbusRegisters(endpoint, 0, [70000])).rejects.toMatchObject({ code: "VALIDATION" });
  });
});
