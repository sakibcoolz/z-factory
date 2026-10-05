/**
 * From the designer's canvas to the floor of the 3D view. A device stands where it was
 * placed in the designer: there is one layout of a factory, drawn twice.
 */

/** Canvas pixels per metre: the designer's default grid puts devices 2 m apart. */
export const CANVAS_UNITS_PER_METRE = 120;
/** Free floor around the outermost devices, in metres. */
const MARGIN = 2;
/** A scene is never smaller than this, so an empty or tiny factory still has a floor. */
const MIN_EXTENT = 4;

export type CanvasPoint = { x: number; y: number };
export type FloorPoint = { x: number; z: number };

/**
 * Floor positions in metres, centred on the middle of the layout: canvas x runs to the
 * right, canvas y towards the viewer. `extent` is half the side of the floor.
 */
export function layoutFloor(points: readonly CanvasPoint[]): { positions: FloorPoint[]; extent: number } {
  if (points.length === 0) return { positions: [], extent: MIN_EXTENT };
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const centerX = (Math.min(...xs) + Math.max(...xs)) / 2;
  const centerY = (Math.min(...ys) + Math.max(...ys)) / 2;
  const positions = points.map((point) => ({
    x: round((point.x - centerX) / CANVAS_UNITS_PER_METRE),
    z: round((point.y - centerY) / CANVAS_UNITS_PER_METRE),
  }));
  const reach = Math.max(...positions.map((position) => Math.max(Math.abs(position.x), Math.abs(position.z))));
  return { positions, extent: Math.max(MIN_EXTENT, Math.ceil(reach + MARGIN)) };
}

/** Millimetre precision: positions are compared and printed, not accumulated. */
function round(value: number): number {
  const rounded = Math.round(value * 1000) / 1000;
  return rounded === 0 ? 0 : rounded;
}
