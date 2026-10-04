import { describe, expect, it } from "vitest";
import { isWritableTagRole } from "@/lib/domain/tag";
import { designer, devices, ioMapping, liveTags, plcExport, topology } from "./pump-house-demo";

describe("design fixtures respect domain invariants", () => {
  it("keeps device instance names unique within the factory", () => {
    const names = devices.map((device) => device.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it("places only known device instances on the designer canvas", () => {
    const known = new Set(devices.map((device) => device.name));
    for (const node of designer.nodes) {
      expect(known.has(node.name)).toBe(true);
    }
    expect(designer.nodes).toHaveLength(devices.length);
  });

  it("marks only the external gateway as outside the factory network", () => {
    const external = (nodes: typeof designer.nodes) => nodes.filter((node) => node.external).map((node) => node.name);
    expect(external(designer.nodes)).toEqual(["gateway-01"]);
    expect(external(topology.nodes)).toEqual(["gateway-01"]);
  });

  it("gives write access to command/setpoint mappings only", () => {
    for (const row of ioMapping.rows) {
      if (!row.role || !row.access) continue;
      expect(row.access === "RW").toBe(isWritableTagRole(row.role));
    }
  });

  it("does not reuse a logical address or a tag name across mapped rows", () => {
    const logical = ioMapping.rows.map((row) => row.logical);
    const tags = ioMapping.rows.flatMap((row) => (row.tag ? [row.tag] : []));
    expect(new Set(logical).size).toBe(logical.length);
    expect(new Set(tags).size).toBe(tags.length);
  });

  it("attributes every live tag to a device instance of the factory", () => {
    const known = new Set(devices.map((device) => device.name));
    for (const tag of liveTags.tags) {
      expect(known.has(tag.device)).toBe(true);
    }
  });

  it("lists the 15 report sections of the PLC engineering export", () => {
    expect(plcExport.sections).toHaveLength(15);
  });
});
