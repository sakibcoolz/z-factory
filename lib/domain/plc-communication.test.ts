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
  const command = (name: string, overrides: Partial<LinkTag> = {}) =>
    tag("b", name, {
      role: "COMMAND",
      accessMode: "READ_WRITE",
      logicalAddress: "%QX100.0",
      dataType: "BOOL",
      protocolArea: "COIL",
      ...overrides,
    });
  const mappingRule = (fn: () => unknown) => rule(fn);

  it("reads any server tag into free %M memory of the client", () => {
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "READ",
          tag("a", "B_TEMP"),
          tag("b", "TEMP", { logicalAddress: "%IW0", protocolArea: "INPUT_REGISTER" }),
          link,
        ),
      ),
    ).toBeUndefined();
    // A remote output is observed, never driven: reading it is fine.
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "READ",
          tag("a", "B_RUN", { dataType: "BOOL", logicalAddress: "%MX5.0", protocolArea: "COIL" }),
          tag("b", "RUN", { dataType: "BOOL", logicalAddress: "%QX0.0", protocolArea: "COIL", plcIoPointId: "p1" }),
          link,
        ),
      ),
    ).toBeUndefined();
  });

  it("refuses a READ into anything the link does not alone own", () => {
    const remote = tag("b", "TEMP");
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "Q", { logicalAddress: "%QW3" }), remote, link))).toBe(
      "plc-link-local-read",
    );
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "AI", { plcIoPointId: "p" }), remote, link))).toBe(
      "plc-link-local-read",
    );
    expect(
      mappingRule(() =>
        checkLinkMapping("READ", tag("a", "C", { role: "SETPOINT", accessMode: "READ_WRITE" }), remote, link),
      ),
    ).toBe("plc-link-local-read");
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "D", { sourceSignal: "value" }), remote, link))).toBe(
      "plc-link-local-read",
    );
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "M", { moduleBound: true }), remote, link))).toBe(
      "plc-link-local-read",
    );
  });

  it("writes only a value the client's program computes, and only to a command or setpoint of the server", () => {
    const programOutput = tag("a", "START_B", { dataType: "BOOL", logicalAddress: "%QX101.0", protocolArea: "COIL" });
    expect(mappingRule(() => checkLinkMapping("WRITE", programOutput, command("START"), link))).toBeUndefined();
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "WRITE",
          tag("a", "SP_B", { logicalAddress: "%MW20" }),
          command("SP", {
            role: "SETPOINT",
            dataType: "INT16",
            logicalAddress: "%QW100",
            protocolArea: "HOLDING_REGISTER",
          }),
          link,
        ),
      ),
    ).toBeUndefined();
    // A gateway's command on the client would reach the server past the client's program.
    const gatewayCommand = tag("a", "GW", {
      role: "COMMAND",
      accessMode: "READ_WRITE",
      dataType: "BOOL",
      logicalAddress: "%QX102.0",
    });
    expect(mappingRule(() => checkLinkMapping("WRITE", gatewayCommand, command("START"), link))).toBe(
      "plc-link-local-write",
    );
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "WRITE",
          tag("a", "IN", { dataType: "BOOL", plcIoPointId: "p", logicalAddress: "%MX0.0" }),
          command("START"),
          link,
        ),
      ),
    ).toBe("plc-link-local-write");
    // The server's own outputs and feedback are not written from outside.
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "WRITE",
          programOutput,
          tag("b", "RUN", { dataType: "BOOL", logicalAddress: "%QX0.0", plcIoPointId: "p" }),
          link,
        ),
      ),
    ).toBe("plc-link-remote-write");
    expect(
      mappingRule(() =>
        checkLinkMapping("WRITE", programOutput, tag("b", "FB", { dataType: "BOOL", logicalAddress: "%MX0.1" }), link),
      ),
    ).toBe("plc-link-remote-write");
  });

  it("checks the ends, the mapping, the type and the unit", () => {
    expect(mappingRule(() => checkLinkMapping("READ", tag("b", "X"), tag("b", "Y"), link))).toBe("plc-link-tag-plc");
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "X"), tag("a", "Y"), link))).toBe("plc-link-tag-plc");
    expect(
      mappingRule(() =>
        checkLinkMapping("READ", tag("a", "X"), tag("b", "Y", { protocolArea: null, protocolAddress: null }), link),
      ),
    ).toBe("plc-link-modbus");
    expect(mappingRule(() => checkLinkMapping("READ", tag("a", "X", { dataType: "BOOL" }), tag("b", "Y"), link))).toBe(
      "plc-link-data-type",
    );
    expect(
      mappingRule(() => checkLinkMapping("READ", tag("a", "X", { unit: "bar" }), tag("b", "Y", { unit: "°C" }), link)),
    ).toBe("plc-link-unit");
    // Widths and scaling may differ: the codec carries engineering values and saturates.
    expect(
      mappingRule(() =>
        checkLinkMapping(
          "READ",
          tag("a", "X", { dataType: "FLOAT32", logicalAddress: "%MD3" }),
          tag("b", "Y", { unit: "bar" }),
          link,
        ),
      ),
    ).toBeUndefined();
  });
});
