/**
 * How the 3D view lays the physical conductors of one connection (TASK-405). A wiring
 * edge with N stored wires is N thin lines side by side between the two devices; a
 * relationship that is not wiring stays one line. Pure; importable anywhere.
 */
import type { SceneConductorView } from "@/lib/domain/scene-view";
import type { WireEndpointKind } from "@/lib/validation/wiring";

/** Distance between neighbouring conductors on the floor, in metres. */
export const CONDUCTOR_SPACING = 0.07;
/** Height of the conductors above the floor, in metres; a hair above the logical line. */
export const CONDUCTOR_HEIGHT = 0.05;

export type Point = { x: number; z: number };

/**
 * Where the conductors of a connection lie: a bundle centred on the straight line between
 * the two devices, spread sideways. The first conductor is the leftmost seen from `from`.
 */
export function conductorPoints(
  from: Point,
  to: Point,
  count: number,
  spacing = CONDUCTOR_SPACING,
): Array<[start: [number, number, number], end: [number, number, number]]> {
  const dx = to.x - from.x;
  const dz = to.z - from.z;
  const length = Math.hypot(dx, dz) || 1;
  // Unit vector across the run, so the bundle spreads sideways whichever way the run goes.
  const across = { x: -dz / length, z: dx / length };
  return Array.from({ length: count }, (_, index) => {
    const offset = (index - (count - 1) / 2) * spacing;
    return [
      [from.x + across.x * offset, CONDUCTOR_HEIGHT, from.z + across.z * offset],
      [to.x + across.x * offset, CONDUCTOR_HEIGHT, to.z + across.z * offset],
    ];
  });
}

export type ConductorStyle = { dashed: boolean; dash: number; gap: number; width: number };

/**
 * How a conductor of each kind is drawn: a signal is a thin solid line, power a heavier
 * one, 0 V and earth are dashed, a bus link is the network dash of the 2D view.
 */
export function conductorStyle(kind: WireEndpointKind): ConductorStyle {
  switch (kind) {
    case "POWER":
      return { dashed: false, dash: 1, gap: 0, width: 2.5 };
    case "COMMON":
      return { dashed: true, dash: 0.12, gap: 0.08, width: 1.5 };
    case "EARTH":
      return { dashed: true, dash: 0.05, gap: 0.1, width: 1.5 };
    case "BUS":
      return { dashed: true, dash: 0.3, gap: 0.18, width: 1.5 };
    default:
      return { dashed: false, dash: 1, gap: 0, width: 1.5 };
  }
}

/** `3 conductors · U → U, V → V, W → W`, for the panel of a selected device. */
export function describeConductors(conductors: readonly SceneConductorView[]): string {
  const ends = conductors.map((conductor) => {
    const from = conductor.from.split(" / ").at(-1) ?? conductor.from;
    const to = conductor.to.split(" / ").at(-1) ?? conductor.to;
    return `${from} → ${to}`;
  });
  return `${conductors.length} conductor${conductors.length === 1 ? "" : "s"} · ${ends.join(", ")}`;
}
