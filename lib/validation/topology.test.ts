import { describe, expect, it } from "vitest";
import { defaultPosition, linkOptions, type TopologyParty } from "./topology";

const party = (id: string, categoryCode: string, extra: Partial<TopologyParty> = {}): TopologyParty => ({
  id,
  name: id.toUpperCase(),
  isPlc: categoryCode === "PLC",
  categoryCode,
  simulatorType: "NONE",
  requiresMotor: false,
  hasTerminals: false,
  protocols: [],
  ...extra,
});

const plc = party("plc", "PLC", { protocols: ["MODBUS_TCP"] });
const vfd = party("vfd", "VFD", { simulatorType: "VFD", hasTerminals: true });
const motor = party("motor", "MOTOR", { simulatorType: "MOTOR" });
const pump = party("pump", "PUMP", { simulatorType: "PUMP", requiresMotor: true });
const sensor = party("pt", "SENSOR", { simulatorType: "SENSOR", hasTerminals: true });
const kinds = (from: TopologyParty, to: TopologyParty) =>
  linkOptions(from, to).map((option) => [option.kind, option.sourceId, option.targetId]);

describe("link options between two devices", () => {
  it("wires a device with terminals to a PLC, whichever way the edge is drawn", () => {
    expect(kinds(plc, vfd)).toEqual([["WIRE_IO", "plc", "vfd"]]);
    expect(kinds(vfd, plc)).toEqual([["WIRE_IO", "plc", "vfd"]]);
    expect(linkOptions(sensor, plc)[0]?.label).toBe("Wire PT to PLC pin by pin");
  });

  it("links a protocol device to a PLC only over a protocol both have", () => {
    const modbusDrive = party("vfd2", "VFD", { protocols: ["MODBUS_TCP"] });
    expect(kinds(plc, modbusDrive)).toEqual([["COMMUNICATES_WITH", "plc", "vfd2"]]);
    expect(kinds(party("plc2", "PLC"), modbusDrive)).toEqual([]);
    // A device with neither terminals nor a shared protocol has nothing to connect to a PLC with.
    expect(kinds(plc, pump)).toEqual([]);
  });

  it("stores drive, shaft and measurement relationships in their own direction", () => {
    expect(kinds(vfd, motor)).toEqual([["DRIVES", "vfd", "motor"]]);
    expect(kinds(motor, vfd)).toEqual([["DRIVES", "vfd", "motor"]]);
    expect(kinds(pump, motor)).toEqual([["MECHANICALLY_DRIVES", "motor", "pump"]]);
    expect(kinds(pump, sensor)).toEqual([["MEASURES", "pt", "pump"]]);
  });

  it("offers a choice when more than one relationship makes sense", () => {
    const contactor = party("k1", "CONTACTOR", { hasTerminals: true });
    const pressureSwitch = party("ps", "SWITCH", { simulatorType: "SWITCH", hasTerminals: true });
    expect(kinds(contactor, pressureSwitch)).toEqual([
      ["MEASURES", "ps", "k1"],
      ["CONTROLS", "k1", "ps"],
      // Two devices with terminals can also be wired pin by pin; offered last.
      ["WIRE_IO", "k1", "ps"],
    ]);
    // Drawn the other way the measurement and the wiring remain: a switch does not control a contactor.
    expect(kinds(pressureSwitch, contactor)).toEqual([
      ["MEASURES", "ps", "k1"],
      ["WIRE_IO", "ps", "k1"],
    ]);
  });

  it("lets controllers and remote I/O control devices, and nothing else", () => {
    const controller = party("tc", "TEMPERATURE_CONTROLLER");
    const heater = party("eh", "HEATER");
    expect(kinds(controller, heater)).toEqual([["CONTROLS", "tc", "eh"]]);
    expect(kinds(heater, controller)).toEqual([]);
    expect(kinds(party("rio", "REMOTE_IO"), party("xv", "VALVE", { simulatorType: "VALVE" }))).toEqual([
      ["CONTROLS", "rio", "xv"],
    ]);
    expect(kinds(pump, heater)).toEqual([]);
  });

  it("offers nothing for a device with itself or for two PLCs", () => {
    expect(kinds(vfd, vfd)).toEqual([]);
    expect(kinds(plc, party("plc2", "PLC", { protocols: ["MODBUS_TCP"] }))).toEqual([]);
  });
});

describe("default canvas positions", () => {
  it("lays unplaced devices out on a grid without overlap", () => {
    const positions = Array.from({ length: 9 }, (_, index) => defaultPosition(index));
    expect(new Set(positions.map((position) => `${position.x},${position.y}`)).size).toBe(9);
    expect(positions[0]).toEqual({ x: 60, y: 60 });
    expect(positions[4]).toEqual({ x: 60, y: 210 });
  });
});
