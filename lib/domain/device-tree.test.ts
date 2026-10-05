import { describe, expect, it } from "vitest";
import { buildDeviceTree, countDescendants, type DeviceTreeNode, flattenDeviceTree } from "./device-tree";

type Device = { id: string; name: string; plc?: boolean };

const device = (name: string, plc = false): Device => ({ id: name.toLowerCase(), name, plc });
const link = (source: string, target: string) => ({ sourceId: source.toLowerCase(), targetId: target.toLowerCase() });
const isPlc = (item: Device) => item.plc === true;

/** `PLC-01(VFD-01(M-01), PT-101)`: a tree as text. */
const text = (nodes: DeviceTreeNode<Device>[]): string =>
  nodes.map((node) => node.device.name + (node.children.length > 0 ? `(${text(node.children)})` : "")).join(", ");

describe("device hierarchy", () => {
  it("puts the devices connected to a PLC below it, whichever way the connection points", () => {
    const devices = [device("XV-101"), device("PLC-01", true), device("PT-101")];
    // A sensor feeds back to the PLC; the PLC controls the valve.
    const tree = buildDeviceTree(devices, [link("PT-101", "PLC-01"), link("PLC-01", "XV-101")], isPlc);
    expect(text(tree)).toBe("PLC-01(PT-101, XV-101)");
  });

  it("hangs a device under the device it is reached through", () => {
    const devices = [device("PLC-01", true), device("VFD-01"), device("M-01"), device("P-01"), device("PT-101")];
    const links = [link("PLC-01", "VFD-01"), link("VFD-01", "M-01"), link("M-01", "P-01"), link("PT-101", "PLC-01")];
    expect(text(buildDeviceTree(devices, links, isPlc))).toBe("PLC-01(PT-101, VFD-01(M-01(P-01)))");
  });

  it("takes the shortest way to the PLC when a device is connected twice", () => {
    const devices = [device("PLC-01", true), device("VFD-01"), device("M-01")];
    // The motor is driven by the drive and also wired to the PLC itself.
    const links = [link("PLC-01", "VFD-01"), link("VFD-01", "M-01"), link("M-01", "PLC-01"), link("PLC-01", "M-01")];
    expect(text(buildDeviceTree(devices, links, isPlc))).toBe("PLC-01(M-01, VFD-01)");
  });

  it("does not hang a device under the sensor that measures it", () => {
    const devices = [device("PLC-01", true), device("VFD-01"), device("M-01"), device("P-01"), device("PT-101")];
    const measures = { ...link("PT-101", "P-01"), weak: true };
    const chain = [link("PLC-01", "VFD-01"), link("VFD-01", "M-01"), link("M-01", "P-01")];
    // Wired to the PLC, the sensor is the PLC's; the pump stays in its drive chain.
    expect(text(buildDeviceTree(devices, [measures, link("PT-101", "PLC-01"), ...chain], isPlc))).toBe(
      "PLC-01(PT-101, VFD-01(M-01(P-01)))",
    );
    // Not wired anywhere, the sensor is found with what it measures.
    expect(text(buildDeviceTree(devices, [measures, ...chain], isPlc))).toBe("PLC-01(VFD-01(M-01(P-01(PT-101))))");
    // And a pump that has nothing but its sensor is found with the sensor.
    expect(text(buildDeviceTree(devices, [measures, link("PT-101", "PLC-01")], isPlc))).toBe(
      "PLC-01(PT-101(P-01)), M-01, VFD-01",
    );
  });

  it("lists every device once, under the PLC it is nearest to", () => {
    const devices = [device("PLC-01", true), device("PLC-02", true), device("GW-01"), device("VFD-01"), device("M-01")];
    const links = [
      link("PLC-01", "PLC-02"),
      link("GW-01", "PLC-01"),
      link("GW-01", "PLC-02"),
      link("PLC-02", "VFD-01"),
      link("VFD-01", "M-01"),
    ];
    const tree = buildDeviceTree(devices, links, isPlc);
    // Two PLCs that talk to each other stay side by side; the shared gateway goes to the first.
    expect(text(tree)).toBe("PLC-01(GW-01), PLC-02(VFD-01(M-01))");
    expect(
      flattenDeviceTree(tree)
        .map((row) => row.device.name)
        .sort(),
    ).toEqual(devices.map((item) => item.name).sort());
  });

  it("keeps devices without a way to a PLC as roots of their own, a chain under its first device", () => {
    const devices = [device("PLC-01", true), device("M-02"), device("VFD-02"), device("LS-9"), device("PT-101")];
    const links = [link("PT-101", "PLC-01"), link("VFD-02", "M-02")];
    expect(text(buildDeviceTree(devices, links, isPlc))).toBe("PLC-01(PT-101), LS-9, VFD-02(M-02)");
  });

  it("works without a PLC and with devices connected in a ring", () => {
    const devices = [device("B"), device("A"), device("C")];
    expect(text(buildDeviceTree(devices, [link("A", "B"), link("B", "C"), link("C", "A")], isPlc))).toBe("A(B, C)");
    expect(buildDeviceTree([], [], isPlc)).toEqual([]);
  });

  it("orders names the way people number them and ignores connections it cannot use", () => {
    const devices = [device("PLC-01", true), device("P-10"), device("P-2")];
    const links = [link("PLC-01", "P-10"), link("PLC-01", "P-2"), link("P-2", "P-2"), link("PLC-01", "GONE")];
    expect(text(buildDeviceTree(devices, links, isPlc))).toBe("PLC-01(P-2, P-10)");
  });

  it("flattens to rows with depth, root and the number of devices below", () => {
    const devices = [device("PLC-01", true), device("VFD-01"), device("M-01"), device("LS-9")];
    const tree = buildDeviceTree(devices, [link("PLC-01", "VFD-01"), link("VFD-01", "M-01")], isPlc);
    expect(countDescendants(tree[0] as DeviceTreeNode<Device>)).toBe(2);
    expect(flattenDeviceTree(tree).map((row) => [row.device.name, row.depth, row.rootId, row.descendants])).toEqual([
      ["PLC-01", 0, "plc-01", 2],
      ["VFD-01", 1, "plc-01", 1],
      ["M-01", 2, "plc-01", 0],
      ["LS-9", 0, "ls-9", 0],
    ]);
  });
});
