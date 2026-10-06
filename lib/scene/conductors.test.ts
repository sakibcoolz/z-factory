import { describe, expect, it } from "vitest";
import { CONDUCTOR_HEIGHT, conductorPoints, conductorStyle, describeConductors } from "./conductors";

describe("conductor layout", () => {
  it("lays N conductors side by side, centred on the line between the two devices", () => {
    const lines = conductorPoints({ x: 0, z: 0 }, { x: 4, z: 0 }, 3, 0.1);
    expect(lines).toEqual([
      [
        [0, CONDUCTOR_HEIGHT, -0.1],
        [4, CONDUCTOR_HEIGHT, -0.1],
      ],
      [
        [0, CONDUCTOR_HEIGHT, 0],
        [4, CONDUCTOR_HEIGHT, 0],
      ],
      [
        [0, CONDUCTOR_HEIGHT, 0.1],
        [4, CONDUCTOR_HEIGHT, 0.1],
      ],
    ]);
  });

  it("spreads the bundle across the run whichever way it goes, and gives one conductor the line itself", () => {
    const [left, right] = conductorPoints({ x: 0, z: 0 }, { x: 0, z: 2 }, 2, 0.1);
    expect(left?.[0]).toEqual([0.05, CONDUCTOR_HEIGHT, 0]);
    expect(right?.[0]).toEqual([-0.05, CONDUCTOR_HEIGHT, 0]);
    expect(conductorPoints({ x: 1, z: 1 }, { x: 3, z: 3 }, 1)).toEqual([
      [
        [1, CONDUCTOR_HEIGHT, 1],
        [3, CONDUCTOR_HEIGHT, 3],
      ],
    ]);
    expect(conductorPoints({ x: 1, z: 1 }, { x: 1, z: 1 }, 2)).toHaveLength(2);
  });

  it("draws power heavier and solid, 0 V and earth dashed, a bus like the network line", () => {
    expect(conductorStyle("POWER")).toMatchObject({ dashed: false, width: 2.5 });
    expect(conductorStyle("SIGNAL")).toMatchObject({ dashed: false, width: 1.5 });
    expect(conductorStyle("COMMON").dashed).toBe(true);
    expect(conductorStyle("EARTH").dashed).toBe(true);
    expect(conductorStyle("BUS")).toMatchObject({ dashed: true, dash: 0.3 });
  });

  it("describes a bundle by its terminal labels", () => {
    const conductor = (from: string, to: string) => ({ id: from, kind: "POWER" as const, from, to });
    expect(
      describeConductors([
        conductor("VFD-01 / U", "MOTOR-01 / U"),
        conductor("VFD-01 / V", "MOTOR-01 / V"),
        conductor("VFD-01 / W", "MOTOR-01 / W"),
      ]),
    ).toBe("3 conductors · U → U, V → V, W → W");
    expect(describeConductors([conductor("PT-101 / OUT", "PLC-01 / AI 0")])).toBe("1 conductor · OUT → AI 0");
  });
});
