/**
 * Shapes the 3D factory view renders (docs/design.md → 3D). Pure types; importable anywhere.
 *
 * The scene is a picture of the factory, not a model of it: devices, connections and
 * states are the ones the designer and the topology view show. Nothing is stored for
 * the scene except how an instance is turned and sized in it.
 */
import type { ConnectionRelationship } from "@/lib/domain/device";
import type { RuntimeState } from "@/lib/domain/runtime-state";

/** The reusable 3D asset of a catalog model, as far as a renderer needs it. */
export type SceneAssetView = {
  id: string;
  version: number;
  /** Where the GLB is served from. One URL per asset version: it never changes content. */
  url: string;
  /** Uniform scale for the file's units; null fits the model to its category's footprint. */
  scale: number | null;
  /** Degrees about the vertical axis that turn the file's front to the scene's front. */
  rotationYDeg: number;
};

/** Generic shapes a device is drawn as while its catalog model has no usable asset. */
export const PLACEHOLDER_KINDS = [
  "cabinet",
  "module",
  "motor",
  "pump",
  "fan",
  "conveyor",
  "vessel",
  "valve",
  "sensor",
  "switch",
  "lamp",
  "panel",
  "box",
] as const;
export type PlaceholderKind = (typeof PLACEHOLDER_KINDS)[number];

export type PlaceholderSpec = {
  kind: PlaceholderKind;
  /** Width, height and depth of the space the device takes, in metres. */
  size: readonly [number, number, number];
};

export type SceneDeviceView = {
  id: string;
  /** Instance name, unique within the factory. */
  name: string;
  role: string | null;
  categoryCode: string;
  categoryName: string;
  manufacturer: string;
  modelId: string;
  modelName: string;
  isPlc: boolean;
  /** Last stored runtime state. Colouring and live state are layered on by the renderer. */
  runtimeStatus: RuntimeState;
  /** Position on the floor in metres, from where the device stands in the designer. */
  position: { x: number; z: number };
  /** Rotation of this instance about the vertical axis, in degrees. */
  rotationDeg: number;
  /** Size of this instance relative to its asset. */
  scale: number;
  /** The catalog model's asset; null while it has none that can be rendered. */
  asset: SceneAssetView | null;
  /** What is drawn instead of the asset, and the space an asset is fitted into. */
  placeholder: PlaceholderSpec;
};

export type SceneConnectionView = {
  id: string;
  relationship: ConnectionRelationship;
  sourceId: string;
  targetId: string;
  /** Same line styles as the 2D topology: signal solid, network dashed, feedback dotted. */
  line: "signal" | "network" | "feedback";
  label: string;
};

export type FactorySceneView = {
  factory: { id: string; name: string; slug: string; runtimeStatus: RuntimeState };
  devices: SceneDeviceView[];
  connections: SceneConnectionView[];
  /** Half the side of the square floor that holds every device, in metres. */
  extent: number;
};

/** How far an instance may be scaled in the scene. */
export const SCENE_SCALE_RANGE = { min: 0.25, max: 4 } as const;
/** One step of the rotate buttons, in degrees. */
export const SCENE_ROTATION_STEP = 45;

/** Any angle as the equivalent one in `[0, 360)`. */
export function normalizeDegrees(degrees: number): number {
  const normalized = degrees % 360;
  return normalized < 0 ? normalized + 360 : normalized === 0 ? 0 : normalized;
}
