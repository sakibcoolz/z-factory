import { describe, expect, it } from "vitest";
import { checkWire, endpointSummary, orientWire, pointFlow, type WireEndpoint, wireRelationship } from "./wiring";

const endpoint = (deviceName: string, label: string, overrides: Partial<WireEndpoint> = {}): WireEndpoint => ({
  deviceId: deviceName,
  deviceName,
  type: "DEVICE_IO",
  id: `${deviceName}/${label}`,
  label,
  kind: "SIGNAL",
  flow: "OUT",
  signalClass: "DIGITAL",
  signalType: "DC_24V",
  acceptedSignalTypes: [],
  protocols: [],
  maxConnections: 1,
  wires: [],
  ...overrides,
});

const point = (label: string, ioType: "DI" | "DO" | "AI" | "AO", overrides: Partial<WireEndpoint> = {}) =>
  endpoint("PLC-01", label, {
    type: "PLC_IO_POINT",
    ...pointFlow(ioType),
    signalType: ioType === "AI" || ioType === "AO" ? "CURRENT_4_20MA" : "DC_24V",
    ...overrides,
  });

const analogOut = (deviceName: string, signalType = "CURRENT_4_20MA") =>
  endpoint(deviceName, "OUT", { signalClass: "ANALOG", signalType });
const supply = endpoint("PS-01", "+24V", { kind: "POWER", signalClass: null, maxConnections: 3 });
const supplyIn = (deviceName: string) => endpoint(deviceName, "+24V", { kind: "POWER", flow: "IN", signalClass: null });
const passive = (deviceName: string, label: string, kind: "COMMON" | "EARTH", maxConnections = 1) =>
  endpoint(deviceName, label, { kind, flow: "NONE", signalClass: null, signalType: null, maxConnections });
const port = (deviceName: string, protocols: string[], maxConnections = 2) =>
  endpoint(deviceName, "Ethernet", {
    type: "PROTOCOL_PORT",
    kind: "BUS",
    flow: "NONE",
    signalClass: null,
    signalType: null,
    protocols,
    maxConnections,
  });

const wired = (target: WireEndpoint, other: WireEndpoint, wireId = "w1"): WireEndpoint => ({
  ...target,
  wires: [
    ...target.wires,
    {
      wireId,
      otherDeviceId: other.deviceId,
      otherEndpointId: other.id,
      otherName: `${other.deviceName} / ${other.label}`,
    },
  ],
});

describe("one wire between two endpoints", () => {
  it("accepts a device output on a PLC input and a PLC output on a device input", () => {
    expect(checkWire(endpoint("LS-1", "OUT"), point("DI a.0", "DI"))).toBeNull();
    expect(checkWire(point("DO a.0", "DO"), endpoint("XV-1", "Y1", { flow: "IN" }))).toBeNull();
    expect(checkWire(analogOut("PT-101"), point("AI 0", "AI"))).toBeNull();
  });

  it("names both endpoints and the rule when the direction is wrong", () => {
    expect(checkWire(endpoint("LS-1", "OUT"), point("DO a.0", "DO"))).toEqual({
      rule: "wire-direction",
      message: "LS-1 / OUT and PLC-01 / DO a.0 both drive a signal; an output is wired to an input.",
    });
    expect(checkWire(endpoint("XV-1", "Y1", { flow: "IN" }), point("DI a.0", "DI"))?.message).toBe(
      "XV-1 / Y1 and PLC-01 / DI a.0 both read a signal; an output is wired to an input.",
    );
  });

  it("refuses digital against analog", () => {
    expect(checkWire(analogOut("PT-101"), point("DI a.0", "DI"))).toEqual({
      rule: "wire-signal-class",
      message: "PT-101 / OUT is analog and PLC-01 / DI a.0 is digital.",
    });
  });

  it("refuses an electrical standard the other end does not take, and accepts a range inside a wider one", () => {
    expect(checkWire(analogOut("PT-101", "VOLTAGE_0_10V"), point("AI 0", "AI"))).toEqual({
      rule: "wire-signal-type",
      message: "PT-101 / OUT is 0–10 V; PLC-01 / AI 0 takes 4–20 mA.",
    });
    // A channel that can be set to another standard takes it.
    const configurable = point("AI 0", "AI", { acceptedSignalTypes: ["VOLTAGE_0_10V"] });
    expect(checkWire(analogOut("PT-101", "VOLTAGE_0_10V"), configurable)).toBeNull();
    // 4–20 mA lies inside 0–20 mA.
    expect(checkWire(analogOut("PT-101"), point("AI 0", "AI", { signalType: "CURRENT_0_20MA" }))).toBeNull();
  });

  it("wires a signal between two devices when the reading end takes what is driven", () => {
    const reference = endpoint("VFD-01", "REF", { flow: "IN", signalClass: "ANALOG", signalType: "VOLTAGE_0_10V" });
    expect(checkWire(analogOut("TC-01", "VOLTAGE_0_10V"), reference)).toBeNull();
    expect(checkWire(analogOut("TC-01"), reference)?.rule).toBe("wire-signal-type");
    expect(checkWire(reference, analogOut("TC-01"))?.message).toBe(
      "TC-01 / OUT is 4–20 mA; VFD-01 / REF takes 0–10 V.",
    );
  });

  it("refuses a second wire on a signal endpoint and says where the first one goes", () => {
    const input = wired(point("DI a.0", "DI"), endpoint("LS-1", "OUT"));
    expect(checkWire(endpoint("LS-2", "OUT"), input)).toEqual({
      rule: "wire-occupied",
      message: "PLC-01 / DI a.0 already has its wire, to LS-1 / OUT.",
    });
    const output = wired(endpoint("LS-1", "OUT"), point("DI a.0", "DI"));
    expect(checkWire(output, point("DI a.1", "DI"))?.message).toBe(
      "LS-1 / OUT already has its wire, to PLC-01 / DI a.0.",
    );
  });

  it("tells two devices of one model apart: the same terminal on another device is another endpoint", () => {
    // Terminal ids come from the catalog model, so both transmitters have the terminal "t-0v".
    const hub = passive("PS-01", "0V", "COMMON", 8);
    const first = { ...passive("PT-101", "0V", "COMMON"), id: "t-0v" };
    const second = { ...passive("PT-102", "0V", "COMMON"), id: "t-0v" };
    expect(checkWire(wired(hub, first), second)).toBeNull();
    expect(checkWire(wired(hub, first), wired(first, hub))?.rule).toBe("wire-duplicate");
  });

  it("refuses the same wire twice", () => {
    const a = passive("PS-01", "0V", "COMMON", 8);
    const b = passive("PT-101", "0V", "COMMON");
    expect(checkWire(wired(a, b), wired(b, a))).toEqual({
      rule: "wire-duplicate",
      message: "PS-01 / 0V is already wired to PT-101 / 0V.",
    });
  });

  it("keeps signal, supply, 0 V, earth and ports apart", () => {
    expect(checkWire(endpoint("LS-1", "OUT"), supplyIn("PT-101"))).toEqual({
      rule: "wire-kind",
      message:
        "LS-1 / OUT is a signal terminal and PT-101 / +24V is a supply terminal; only endpoints of the same kind are wired together.",
    });
    expect(checkWire(passive("PS-01", "0V", "COMMON"), passive("VFD-01", "PE", "EARTH"))?.rule).toBe("wire-kind");
    expect(checkWire(supply, port("GW-01", ["MODBUS_TCP"]))?.rule).toBe("wire-kind");
  });

  it("refuses two endpoints of one device", () => {
    expect(checkWire(endpoint("VFD-01", "RUNNING"), endpoint("VFD-01", "RUN", { flow: "IN" }))).toEqual({
      rule: "wire-same-device",
      message: "VFD-01 / RUNNING and VFD-01 / RUN are on the same device.",
    });
  });
});

describe("shared endpoints", () => {
  it("lets a supply terminal feed several devices, up to the number of wires it takes", () => {
    let source = supply;
    for (const name of ["PT-101", "PT-102", "PT-103"]) {
      expect(checkWire(source, supplyIn(name))).toBeNull();
      source = wired(source, supplyIn(name), name);
    }
    expect(checkWire(source, supplyIn("PT-104"))).toEqual({
      rule: "wire-occupied",
      message: "PS-01 / +24V already has 3 of the 3 wires it takes.",
    });
  });

  it("still checks a shared endpoint: a supply feeds inputs of its own voltage only", () => {
    expect(checkWire(supply, endpoint("PS-02", "+24V", { kind: "POWER", signalClass: null }))?.message).toBe(
      "PS-01 / +24V and PS-02 / +24V both supply the voltage; an output is wired to an input.",
    );
    expect(checkWire(supplyIn("A"), supplyIn("B"))?.rule).toBe("wire-direction");
    expect(checkWire(supply, { ...supplyIn("PT-101"), signalType: "VOLTAGE_0_10V" })?.rule).toBe("wire-signal-type");
    // The device's own supply input takes one wire.
    const taken = wired(supplyIn("PT-101"), supply);
    expect(
      checkWire(endpoint("PS-02", "+24V", { kind: "POWER", signalClass: null, maxConnections: 8 }), taken)?.rule,
    ).toBe("wire-occupied");
  });

  it("joins 0 V terminals and earth terminals without a direction", () => {
    expect(checkWire(passive("PS-01", "0V", "COMMON", 8), passive("PT-101", "0V", "COMMON"))).toBeNull();
    expect(checkWire(passive("PS-01", "PE", "EARTH", 8), passive("VFD-01", "PE", "EARTH"))).toBeNull();
  });

  it("links ports over a common protocol, within the port's limit", () => {
    const plc = port("PLC-01", ["MODBUS_TCP"]);
    expect(checkWire(plc, port("VFD-02", ["MODBUS_TCP"]))).toBeNull();
    expect(checkWire(plc, port("X-1", ["PROFINET"]))).toEqual({
      rule: "wire-protocol",
      message: "PLC-01 / Ethernet and X-1 / Ethernet have no protocol in common.",
    });
    const full = wired(wired(plc, port("A", ["MODBUS_TCP"]), "w1"), port("B", ["MODBUS_TCP"]), "w2");
    expect(checkWire(full, port("C", ["MODBUS_TCP"]))?.message).toBe(
      "PLC-01 / Ethernet already has 2 of the 2 wires it takes.",
    );
  });
});

describe("replacing a wire", () => {
  it("does not count the wire that is being replaced", () => {
    const sensor = endpoint("LS-1", "OUT");
    const first = point("DI a.0", "DI");
    const second = point("DI a.1", "DI");
    // The sensor's only wire goes to the first input; moving it to the second is allowed.
    expect(checkWire(wired(sensor, first), second)?.rule).toBe("wire-occupied");
    expect(checkWire(wired(sensor, first), second, "w1")).toBeNull();
    // A destination that is taken by another wire stays taken.
    expect(checkWire(wired(sensor, first), wired(second, endpoint("LS-2", "OUT"), "w2"), "w1")?.rule).toBe(
      "wire-occupied",
    );
  });
});

describe("how a wire is stored", () => {
  it("runs from the end that drives or supplies to the end that reads or takes", () => {
    const sensor = endpoint("LS-1", "OUT");
    const input = point("DI a.0", "DI");
    expect(orientWire(input, sensor)).toEqual({ source: sensor, target: input });
    expect(orientWire(supplyIn("PT-101"), supply)).toEqual({ source: supply, target: supplyIn("PT-101") });
    // Without a direction a wire keeps the order it was drawn in.
    const [a, b] = [passive("PS-01", "0V", "COMMON"), passive("PT-101", "0V", "COMMON")];
    expect(orientWire(b, a)).toEqual({ source: b, target: a });
  });

  it("keeps the meaning of PLC I/O and marks every other wire as a wire", () => {
    const output = point("DO a.0", "DO");
    const input = point("DI a.0", "DI");
    expect(wireRelationship(output, endpoint("XV-1", "Y1", { flow: "IN" }))).toBe("CONTROLS");
    expect(wireRelationship(endpoint("LS-1", "OUT"), input)).toBe("FEEDS_BACK_TO");
    expect(wireRelationship(supply, supplyIn("PT-101"))).toBe("WIRED_TO");
    expect(wireRelationship(port("A", ["MODBUS_TCP"]), port("B", ["MODBUS_TCP"]))).toBe("COMMUNICATES_WITH");
  });

  it("describes an endpoint in a few words", () => {
    expect(endpointSummary(point("AI 0", "AI"))).toBe("analog input · 4–20 mA");
    expect(endpointSummary(endpoint("LS-1", "OUT"))).toBe("digital output · 24 V DC");
    expect(endpointSummary(supply)).toBe("supply output · 24 V DC");
    expect(endpointSummary(passive("PS-01", "PE", "EARTH"))).toBe("protective earth");
    expect(endpointSummary(port("PLC-01", ["MODBUS_TCP"]))).toBe("Modbus TCP");
  });
});
