"use client";

import type { ReactNode } from "react";
import type { PlaceholderSpec } from "@/lib/domain/scene-view";
import type { SceneColors } from "./factory-canvas";

type Vec3 = readonly [number, number, number];

/**
 * The generic shape of a device category, built from primitives inside the category's
 * space: origin at the centre of the footprint, standing on the floor. Shapes are
 * schematic on purpose; none imitates a manufacturer's housing.
 */
export function DevicePlaceholder({ spec, colors }: { spec: PlaceholderSpec; colors: SceneColors }) {
  const [width, height, depth] = spec.size;
  const body = <meshStandardMaterial color={colors.body} roughness={0.75} metalness={0.1} />;
  const accent = <meshStandardMaterial color={colors.accent} roughness={0.85} metalness={0.05} />;

  const box = (size: Vec3, position: Vec3, material: ReactNode = body, key?: string) => (
    <mesh key={key} position={position}>
      <boxGeometry args={[...size]} />
      {material}
    </mesh>
  );
  /** A cylinder standing up, or lying along the x or z axis. */
  const cylinder = (
    radius: number,
    length: number,
    position: Vec3,
    axis: "x" | "y" | "z" = "y",
    material: ReactNode = body,
    key?: string,
  ) => (
    <mesh
      key={key}
      position={position}
      rotation={axis === "x" ? [0, 0, Math.PI / 2] : axis === "z" ? [Math.PI / 2, 0, 0] : [0, 0, 0]}
    >
      <cylinderGeometry args={[radius, radius, length, 24]} />
      {material}
    </mesh>
  );

  switch (spec.kind) {
    case "cabinet":
      return (
        <group>
          {box([width, height, depth], [0, height / 2, 0])}
          {box([width * 0.8, height * 0.8, 0.02], [0, height / 2, depth / 2 + 0.01], accent)}
        </group>
      );
    case "module":
      return (
        <group>
          {box([width * 1.2, 0.06, depth * 0.5], [0, height * 0.55, -depth * 0.3], accent)}
          {box([width, height, depth], [0, height / 2, 0])}
        </group>
      );
    case "panel":
      return (
        <group>
          {box([0.08, height * 0.75, 0.08], [0, height * 0.375, 0], accent)}
          {box([width, height * 0.3, depth], [0, height * 0.85, 0])}
        </group>
      );
    case "motor": {
      const radius = Math.min(height, depth) * 0.42;
      return (
        <group>
          {box([width * 0.7, 0.06, depth * 0.9], [0, 0.03, 0], accent)}
          {cylinder(radius, width * 0.75, [-width * 0.05, radius + 0.08, 0], "x")}
          {cylinder(radius * 0.25, width * 0.2, [width * 0.4, radius + 0.08, 0], "x", accent)}
        </group>
      );
    }
    case "pump": {
      const radius = Math.min(height, depth) * 0.36;
      return (
        <group>
          {box([width * 0.9, 0.06, depth * 0.8], [0, 0.03, 0], accent)}
          {cylinder(radius * 0.8, width * 0.5, [-width * 0.2, radius + 0.08, 0], "x")}
          {cylinder(radius * 1.15, depth * 0.35, [width * 0.25, radius + 0.08, 0], "x")}
          {cylinder(radius * 0.4, height * 0.35, [width * 0.25, height * 0.8, 0], "y", accent)}
        </group>
      );
    }
    case "fan": {
      const radius = Math.min(width, height) * 0.45;
      return (
        <group>
          {box([width * 0.7, 0.06, depth], [0, 0.03, 0], accent)}
          {cylinder(radius, depth * 0.45, [0, radius + 0.08, 0], "z")}
          {cylinder(radius * 0.25, depth * 0.6, [0, radius + 0.08, 0], "z", accent)}
        </group>
      );
    }
    case "conveyor":
      return (
        <group>
          {box([width, 0.1, depth], [0, height, 0])}
          {[-1, 1].flatMap((side) =>
            [-1, 1].map((end) =>
              box(
                [0.06, height, 0.06],
                [end * width * 0.45, height / 2, side * depth * 0.4],
                accent,
                `leg${side}${end}`,
              ),
            ),
          )}
        </group>
      );
    case "vessel": {
      const radius = Math.min(width, depth) * 0.48;
      return (
        <group>
          {cylinder(radius, height * 0.85, [0, height * 0.425 + 0.1, 0])}
          {cylinder(radius * 0.3, 0.2, [0, height * 0.95 + 0.1, 0], "y", accent)}
        </group>
      );
    }
    case "valve":
      return (
        <group>
          {cylinder(height * 0.12, width, [0, height * 0.3, 0], "x", accent)}
          {box([width * 0.35, height * 0.3, depth * 0.8], [0, height * 0.3, 0])}
          {cylinder(height * 0.05, height * 0.3, [0, height * 0.6, 0], "y", accent)}
          {box([width * 0.4, height * 0.25, depth * 0.9], [0, height * 0.87, 0])}
        </group>
      );
    case "sensor":
      return (
        <group>
          {cylinder(width * 0.18, height * 0.7, [0, height * 0.35, 0], "y", accent)}
          {box([width, height * 0.3, depth], [0, height * 0.85, 0])}
        </group>
      );
    case "switch":
      return (
        <group>
          {box([0.06, height * 0.8, 0.06], [0, height * 0.4, 0], accent)}
          {box([width, height * 0.22, depth], [0, height * 0.89, 0])}
        </group>
      );
    case "lamp":
      return (
        <group>
          {cylinder(width * 0.15, height * 0.6, [0, height * 0.3, 0], "y", accent)}
          {[0, 1, 2].map((tier) =>
            cylinder(width * 0.45, height * 0.12, [0, height * (0.67 + tier * 0.13), 0], "y", body, `tier${tier}`),
          )}
        </group>
      );
    default:
      return box([width, height, depth], [0, height / 2, 0]);
  }
}
