import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  checkLinkMapping,
  checkPlcLink,
  type LinkTag,
  type LinkEndpointPlc,
  plcLinkServerHost,
  type PlcLinkView,
  toPlcLinkSnapshot,
} from "@/lib/domain/plc-communication";

const plc = (id: string, overrides: Partial<LinkEndpointPlc> = {}): LinkEndpointPlc => ({
  id,
  factoryId: "f1",
  name: `PLC-${id}`,
  model: { capabilities: ["PROGRAMMABLE", "IEC_61131_3", "MODBUS_SERVER"], architectureType: "COMPACT" },
  ...overrides,
});

const rule = (fn: () => unknown) => {
  try {
    fn();
  } catch (error) {
    if (error instanceof DomainError) return error.details.rule;
    throw error;
  }
  return undefined;
};

describe("PLC-to-PLC link rules", () => {
  it("links two programmable controllers of one factory, whichever end is the client", () => {
    expect(rule(() => checkPlcLink(plc("a"), plc("b"), "MODBUS_TCP", "SOURCE"))).toBeUndefined();
    expect(rule(() => checkPlcLink(plc("a"), plc("b"), "MODBUS_TCP", "TARGET"))).toBeUndefined();
  });

  it("refuses a PLC with itself and PLCs of different factories", () => {
    expect(rule(() => checkPlcLink(plc("a"), plc("a"), "MODBUS_TCP", "SOURCE"))).toBe("plc-link-self");
    expect(rule(() => checkPlcLink(plc("a"), plc("b", { factoryId: "f2" }), "MODBUS_TCP", "SOURCE"))).toBe(
      "plc-link-factory",
    );
  });

  it("refuses a device that is not a programmable controller at either end", () => {
    const drive = plc("d", { model: { capabilities: ["MODBUS_SERVER", "REMOTE_CONTROL"], architectureType: null } });
    expect(rule(() => checkPlcLink(plc("a"), drive, "MODBUS_TCP", "SOURCE"))).toBe("plc-link-controller");
    expect(rule(() => checkPlcLink(drive, plc("a"), "MODBUS_TCP", "TARGET"))).toBe("plc-link-controller");
  });

  it("needs the server end to serve the protocol; the client end need not", () => {
    const noServer = plc("c", {
      model: { capabilities: ["PROGRAMMABLE", "IEC_61131_3"], architectureType: "COMPACT" },
    });
    expect(rule(() => checkPlcLink(plc("a"), noServer, "MODBUS_TCP", "SOURCE"))).toBe("plc-link-server-protocol");
    expect(rule(() => checkPlcLink(plc("a"), noServer, "MODBUS_TCP", "TARGET"))).toBeUndefined();
    expect(rule(() => checkPlcLink(noServer, plc("a"), "MODBUS_TCP", "SOURCE"))).toBeUndefined();
  });

  it("addresses the server by its deterministic service name and snapshots the link by names", () => {
    expect(plcLinkServerHost("S7-1200 1214C / Line 2")).toBe("s7-1200-1214c-line-2");
    const view: PlcLinkView = {
      id: "l1",
      factoryId: "f1",
      relationship: "SUPERVISES",
      protocol: "MODBUS_TCP",
      source: { plcId: "a", name: "PLC-A", runtimeStatus: "STOPPED" },
      target: { plcId: "b", name: "PLC-B", runtimeStatus: "RUNNING" },
      client: "SOURCE",
      clientPlcId: "a",
      serverPlcId: "b",
      serverHost: "plc-b",
      serverPort: 502,
      unitId: 1,
      pollIntervalMs: 500,
      enabled: true,
      configVersion: 3,
      mappingCount: 0,
      createdAt: "2026-10-06T00:00:00.000Z",
      updatedAt: "2026-10-06T00:00:00.000Z",
    };
    expect(toPlcLinkSnapshot(view)).toEqual({
      schema: "z-factory.plc-link",
      schemaVersion: 1,
      configVersion: 3,
      link: {
        relationship: "SUPERVISES",
        protocol: "MODBUS_TCP",
        sourcePlc: "PLC-A",
        targetPlc: "PLC-B",
        client: "SOURCE",
        serverHost: "plc-b",
        serverPort: 502,
        unitId: 1,
        pollIntervalMs: 500,
        enabled: true,
      },
      mappings: [],
    });
  });
});

describe("PLC link mappings", () => {
  const link = { clientPlcId: "a", serverPlcId: "b" };
  const tag = (plcId: string, name: string, overrides: Partial<LinkTag> = {}): LinkTag => ({
    id: name,
    plcId,
    name,
    dataType: "INT16",
    unit: null,
    scale: 1,
    offset: 0,
    role: "STATUS",
    accessMode: "READ_ONLY",
    logicalAddress: "%MW10",
    plcIoPointId: null,
    sourceSignal: null,
    protocolArea: "HOLDING_REGISTER",
    protocolAddress: 1034,
    moduleBound: false,
    ...overrides,
  });
  const bit = (plcId: string, name: string, address: string, overrides: Partial<LinkTag> = {}) =>
    tag(plcId, name, {
      dataType: "BOOL",
      logicalAddress: address,
      protocolArea: address.startsWith("%I") ? "DISCRETE_INPUT" : "COIL",
      ...overrides,
    });
  const command = (name: string, overrides: Partial<LinkTag> = {}) =>
    bit("b", name, "%QX100.0", { role: "COMMAND", accessMode: "READ_WRITE", ...overrides });
  const check = (operation: "READ" | "WRITE", local: LinkTag, remote: LinkTag) =>
    rule(() => checkLinkMapping(operation, local, remote, link));

  it("reads a server value into the client's input image or memory", () => {
    expect(
      check("READ", tag("a", "B_TEMP", { logicalAddress: "%IW5", protocolArea: "INPUT_REGISTER" }), tag("b", "TEMP")),
    ).toBeUndefined();
    expect(check("READ", tag("a", "B_TEMP"), tag("b", "TEMP"))).toBeUndefined();
    // A remote output is observed, never driven: reading it into an input bit is fine.
    expect(
      check("READ", bit("a", "B_RUN", "%IX5.0"), bit("b", "RUN", "%QX0.0", { plcIoPointId: "p1" })),
    ).toBeUndefined();
  });

  it("refuses a READ into anything the link does not alone own", () => {
    const remote = tag("b", "TEMP");
    expect(check("READ", tag("a", "Q", { logicalAddress: "%QW3" }), remote)).toBe("plc-link-local-read");
    expect(check("READ", tag("a", "AI", { plcIoPointId: "p" }), remote)).toBe("plc-link-local-read");
    expect(check("READ", tag("a", "C", { role: "SETPOINT", accessMode: "READ_WRITE" }), remote)).toBe(
      "plc-link-local-read",
    );
    expect(check("READ", tag("a", "D", { sourceSignal: "value" }), remote)).toBe("plc-link-local-read");
    expect(check("READ", tag("a", "M", { moduleBound: true }), remote)).toBe("plc-link-local-read");
  });

  it("writes only a value the client's program computes, and only to a command or setpoint of the server", () => {
    const programOutput = bit("a", "START_B", "%QX101.0");
    expect(check("WRITE", programOutput, command("START"))).toBeUndefined();
    const setpoint = tag("b", "SP", { role: "SETPOINT", accessMode: "READ_WRITE", logicalAddress: "%QW100" });
    expect(check("WRITE", tag("a", "SP_B", { logicalAddress: "%MW20" }), setpoint)).toBeUndefined();
    // A gateway's command on the client would reach the server past the client's program.
    const gatewayCommand = bit("a", "GW", "%QX102.0", { role: "COMMAND", accessMode: "READ_WRITE" });
    expect(check("WRITE", gatewayCommand, command("START"))).toBe("plc-link-local-write");
    expect(check("WRITE", bit("a", "IN", "%MX0.0", { plcIoPointId: "p" }), command("START"))).toBe(
      "plc-link-local-write",
    );
    // The server's own outputs and feedback are not written from outside.
    expect(check("WRITE", programOutput, bit("b", "RUN", "%QX0.0", { plcIoPointId: "p" }))).toBe(
      "plc-link-remote-write",
    );
    expect(check("WRITE", programOutput, bit("b", "FB", "%MX0.1"))).toBe("plc-link-remote-write");
  });

  it("checks the ends, the mapping, the type and the unit", () => {
    expect(check("READ", tag("b", "X"), tag("b", "Y"))).toBe("plc-link-tag-plc");
    expect(check("READ", tag("a", "X"), tag("a", "Y"))).toBe("plc-link-tag-plc");
    expect(check("READ", tag("a", "X"), tag("b", "Y", { protocolArea: null, protocolAddress: null }))).toBe(
      "plc-link-modbus",
    );
    expect(check("READ", bit("a", "X", "%IX0.0"), tag("b", "Y"))).toBe("plc-link-data-type");
    expect(check("READ", tag("a", "X", { unit: "bar" }), tag("b", "Y", { unit: "°C" }))).toBe("plc-link-unit");
  });

  it("carries only what the OpenPLC runtime's Modbus master copies word for word", () => {
    // The runtime copies raw values: same type, same scaling.
    expect(check("READ", tag("a", "X", { scale: 0.1 }), tag("b", "Y"))).toBe("plc-link-adapter");
    expect(check("READ", tag("a", "X", { dataType: "UINT16" }), tag("b", "Y"))).toBe("plc-link-adapter");
    // One-word values only: the master's 32-bit order differs and %MD is not %MW.
    expect(
      check(
        "READ",
        tag("a", "X", { dataType: "FLOAT32", logicalAddress: "%MD3" }),
        tag("b", "Y", { dataType: "FLOAT32", logicalAddress: "%MD0" }),
      ),
    ).toBe("plc-link-adapter");
    // Bits arrive in %IX and leave from %QX; the master does not address %MX.
    expect(check("READ", bit("a", "X", "%MX5.0"), bit("b", "Y", "%QX0.0"))).toBe("plc-link-adapter");
    const memoryBit = bit("a", "X", "%MX5.0");
    expect(check("WRITE", memoryBit, command("START"))).toBe("plc-link-adapter");
  });
});
