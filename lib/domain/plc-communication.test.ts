import { describe, expect, it } from "vitest";
import { DomainError } from "@/lib/domain/errors";
import {
  checkPlcLink,
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
