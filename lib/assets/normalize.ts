import "server-only";
import { DomainError } from "@/lib/domain/errors";
import { fitScale } from "@/lib/scene/placeholders";

/**
 * Brings a GLB from any source into the form every catalog asset has, so assets stand
 * together in one scene: Y is up, the front faces +Z, one unit is one metre, the model
 * fills the space of its device category, and its origin is the middle of its footprint
 * on the floor.
 *
 * The geometry and textures are not touched. The scene's nodes are placed under one new
 * root node that carries the whole transform, so the result is the same file plus one
 * matrix, and normalizing is lossless.
 */

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const BIN_CHUNK = 0x004e4942; // "BIN\0"
const FLOAT = 5126;
const TRIANGLES = 4;

/** How much larger a model must come out after a quarter turn for `auto` to turn it. */
const QUARTER_TURN_GAIN = 1.25;

/** More triangles than this is not a catalog asset for a browser scene with many devices. */
export const MAX_ASSET_TRIANGLES = 200_000;

export type UpAxis = "Y" | "Z";
type Vec3 = [number, number, number];
/** Column-major 4 × 4, as glTF stores it. */
type Mat4 = number[];
type Json = Record<string, unknown>;

export type NormalizeOptions = {
  /** Width, height and depth in metres the model has to fit into: the footprint of its category. */
  space: readonly [number, number, number];
  /** Which axis points up in the file. glTF says Y; a file exported without conversion may say Z. */
  upAxis?: UpAxis;
  /**
   * Degrees about the vertical axis that turn the file's front to +Z. `auto` tries a quarter
   * turn and keeps it when the model then comes out clearly larger (a conveyor lying along
   * the wrong axis); it cannot tell front from back.
   */
  yawDeg?: number | "auto";
};

export type NormalizationReport = {
  upAxis: UpAxis;
  yawDeg: number;
  /** Factor from the file's units to metres. */
  scale: number;
  /** Size of the model as it came, after turning it upright, in file units. */
  sourceSize: Vec3;
  /** Size of the normalized model in metres. */
  size: Vec3;
  /** Box around the normalized model in metres; the anchor is where it stands. */
  bounds: { min: Vec3; max: Vec3; anchor: Vec3 };
  vertices: number;
  triangles: number;
};

const invalid = (rule: string, message: string) => new DomainError("VALIDATION", message, { rule });

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Json =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Json) : {};
const numbers = (value: unknown, length: number): number[] | null => {
  const items = list(value);
  return items.length === length && items.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (items as number[])
    : null;
};
const index = (value: unknown): number | null => (typeof value === "number" && Number.isInteger(value) ? value : null);

const pad4 = (length: number) => (4 - (length % 4)) % 4;

/** Splits a GLB into its glTF description and its binary buffer. */
export function readGlb(bytes: Uint8Array): { gltf: Json; binary: Uint8Array | null } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (bytes.byteLength < 20 || view.getUint32(0, true) !== GLB_MAGIC || view.getUint32(4, true) !== 2) {
    throw invalid("glb-format", "The file is not a glTF 2.0 GLB file.");
  }
  let gltf: Json | null = null;
  let binary: Uint8Array | null = null;
  let offset = 12;
  while (offset + 8 <= bytes.byteLength) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + 8;
    if (start + length > bytes.byteLength) throw invalid("glb-length", "The file is incomplete.");
    const chunk = bytes.subarray(start, start + length);
    if (type === JSON_CHUNK && !gltf) {
      try {
        gltf = record(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(chunk)));
      } catch {
        throw invalid("glb-json", "The glTF description in the file cannot be read.");
      }
    } else if (type === BIN_CHUNK && !binary) binary = chunk;
    offset = start + length;
  }
  if (!gltf) throw invalid("glb-format", "The file does not contain a glTF description.");
  return { gltf, binary };
}

/** Assembles a GLB from a glTF description and its binary buffer. */
export function writeGlb(gltf: Json, binary: Uint8Array | null): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = json.length + pad4(json.length);
  const binaryLength = binary ? binary.length + pad4(binary.length) : 0;
  const total = 12 + 8 + jsonLength + (binary ? 8 + binaryLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + jsonLength); // JSON is padded with spaces
  bytes.set(json, 20);
  if (binary) {
    const start = 20 + jsonLength;
    view.setUint32(start, binaryLength, true);
    view.setUint32(start + 4, BIN_CHUNK, true);
    bytes.set(binary, start + 8);
  }
  return bytes;
}

const IDENTITY: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function multiply(a: Mat4, b: Mat4): Mat4 {
  const out = new Array<number>(16).fill(0);
  for (let column = 0; column < 4; column += 1) {
    for (let row = 0; row < 4; row += 1) {
      let sum = 0;
      for (let k = 0; k < 4; k += 1) sum += (a[k * 4 + row] ?? 0) * (b[column * 4 + k] ?? 0);
      out[column * 4 + row] = sum;
    }
  }
  return out;
}

function apply(matrix: Mat4, [x, y, z]: Vec3): Vec3 {
  const at = (row: number) =>
    (matrix[row] ?? 0) * x + (matrix[4 + row] ?? 0) * y + (matrix[8 + row] ?? 0) * z + (matrix[12 + row] ?? 0);
  return [at(0), at(1), at(2)];
}

/** A node's own transform: its matrix, or its translation, rotation and scale. */
function nodeMatrix(node: Json): Mat4 {
  const matrix = numbers(node.matrix, 16);
  if (matrix) return matrix;
  const [tx, ty, tz] = numbers(node.translation, 3) ?? [0, 0, 0];
  const [qx, qy, qz, qw] = numbers(node.rotation, 4) ?? [0, 0, 0, 1];
  const [sx, sy, sz] = numbers(node.scale, 3) ?? [1, 1, 1];
  const [x, y, z, w] = [qx ?? 0, qy ?? 0, qz ?? 0, qw ?? 1];
  return [
    (1 - 2 * (y * y + z * z)) * (sx ?? 1),
    2 * (x * y + z * w) * (sx ?? 1),
    2 * (x * z - y * w) * (sx ?? 1),
    0,
    2 * (x * y - z * w) * (sy ?? 1),
    (1 - 2 * (x * x + z * z)) * (sy ?? 1),
    2 * (y * z + x * w) * (sy ?? 1),
    0,
    2 * (x * z + y * w) * (sz ?? 1),
    2 * (y * z - x * w) * (sz ?? 1),
    (1 - 2 * (x * x + y * y)) * (sz ?? 1),
    0,
    tx ?? 0,
    ty ?? 0,
    tz ?? 0,
    1,
  ];
}

const round = (value: number) => (Math.abs(value) < 1e-12 ? 0 : value);

/** Rotation about the vertical axis; a positive angle turns +Z towards +X. */
function yawMatrix(degrees: number): Mat4 {
  const radians = (degrees * Math.PI) / 180;
  const c = round(Math.cos(radians));
  const s = round(Math.sin(radians));
  return [c, 0, -s, 0, 0, 1, 0, 0, s, 0, c, 0, 0, 0, 0, 1];
}

/** Z-up to Y-up: what was up (+Z) becomes +Y and what faced the viewer (−Y) becomes +Z. */
const Z_UP_TO_Y_UP: Mat4 = [1, 0, 0, 0, 0, 0, -1, 0, 0, 1, 0, 0, 0, 0, 0, 1];

type Extent = { min: Vec3; max: Vec3; vertices: number; triangles: number };

/**
 * The box around everything the default scene draws, with `pre` applied on top of the
 * nodes' own transforms. Vertex positions are read from the file where they are plain
 * floats; otherwise the corners of the box the accessor states are used.
 */
function measure(gltf: Json, binary: Uint8Array | null, roots: number[], pre: Mat4): Extent {
  const nodes = list(gltf.nodes);
  const meshes = list(gltf.meshes);
  const accessors = list(gltf.accessors);
  const bufferViews = list(gltf.bufferViews);
  const extent: Extent = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
    vertices: 0,
    triangles: 0,
  };
  const include = (point: Vec3) => {
    for (let axis = 0; axis < 3; axis += 1) {
      extent.min[axis] = Math.min(extent.min[axis] ?? Infinity, point[axis] ?? 0);
      extent.max[axis] = Math.max(extent.max[axis] ?? -Infinity, point[axis] ?? 0);
    }
  };

  const addPrimitive = (primitive: Json, world: Mat4) => {
    const accessor = record(accessors[index(record(primitive.attributes).POSITION) ?? -1]);
    const count = index(accessor.count) ?? 0;
    if (count === 0 || accessor.type !== "VEC3") return;
    extent.vertices += count;
    if ((index(primitive.mode) ?? TRIANGLES) === TRIANGLES) {
      const indices = record(accessors[index(primitive.indices) ?? -1]);
      extent.triangles += Math.floor((index(indices.count) ?? count) / 3);
    }

    const bufferView = record(bufferViews[index(accessor.bufferView) ?? -1]);
    const stride = index(bufferView.byteStride) ?? 12;
    const start = (index(bufferView.byteOffset) ?? 0) + (index(accessor.byteOffset) ?? 0);
    const readable =
      binary !== null &&
      accessor.componentType === FLOAT &&
      accessor.sparse === undefined &&
      index(accessor.bufferView) !== null &&
      (index(bufferView.buffer) ?? 0) === 0 &&
      stride >= 12 &&
      start + (count - 1) * stride + 12 <= binary.byteLength;
    if (readable) {
      const view = new DataView(binary.buffer, binary.byteOffset, binary.byteLength);
      for (let vertex = 0; vertex < count; vertex += 1) {
        const at = start + vertex * stride;
        include(
          apply(world, [view.getFloat32(at, true), view.getFloat32(at + 4, true), view.getFloat32(at + 8, true)]),
        );
      }
      return;
    }
    const min = numbers(accessor.min, 3);
    const max = numbers(accessor.max, 3);
    if (!min || !max) return;
    for (let corner = 0; corner < 8; corner += 1) {
      include(
        apply(world, [
          (corner & 1 ? max[0] : min[0]) ?? 0,
          (corner & 2 ? max[1] : min[1]) ?? 0,
          (corner & 4 ? max[2] : min[2]) ?? 0,
        ]),
      );
    }
  };

  const visit = (nodeIndex: number, parent: Mat4, path: ReadonlySet<number>) => {
    // A node graph that loops is not a valid file; it must not hang the check either.
    if (path.has(nodeIndex)) throw invalid("glb-nodes", "The nodes of the file refer to each other in a loop.");
    const node = record(nodes[nodeIndex]);
    const world = multiply(parent, nodeMatrix(node));
    const mesh = index(node.mesh);
    if (mesh !== null)
      for (const primitive of list(record(meshes[mesh]).primitives)) addPrimitive(record(primitive), world);
    const below = new Set(path).add(nodeIndex);
    for (const child of list(node.children)) {
      const childIndex = index(child);
      if (childIndex !== null) visit(childIndex, world, below);
    }
  };
  for (const root of roots) visit(root, pre, new Set());
  return extent;
}

const sizeOf = (extent: Extent): Vec3 => [
  extent.max[0] - extent.min[0],
  extent.max[1] - extent.min[1],
  extent.max[2] - extent.min[2],
];

/**
 * Normalizes a GLB for the factory scene and says what was done. The file must already
 * have passed `inspectGlb`; this function only refuses what it cannot place.
 */
export function normalizeGlb(
  bytes: Uint8Array,
  options: NormalizeOptions,
): { bytes: Uint8Array; report: NormalizationReport } {
  const { gltf, binary } = readGlb(bytes);
  const scenes = list(gltf.scenes);
  const sceneIndex = index(gltf.scene) ?? 0;
  const scene = record(scenes[sceneIndex]);
  const roots = list(scene.nodes).flatMap((node) => index(node) ?? []);
  if (roots.length === 0) throw invalid("glb-empty", "The file's scene contains nothing to draw.");

  const upAxis = options.upAxis ?? "Y";
  const upright = upAxis === "Z" ? Z_UP_TO_Y_UP : IDENTITY;
  const candidates = options.yawDeg === undefined || options.yawDeg === "auto" ? [0, 90] : [options.yawDeg];

  let best: { yawDeg: number; rotation: Mat4; extent: Extent; fit: number } | null = null;
  for (const yawDeg of candidates) {
    const rotation = multiply(yawMatrix(yawDeg), upright);
    const extent = measure(gltf, binary, roots, rotation);
    const size = sizeOf(extent);
    if (!size.every(Number.isFinite) || Math.max(...size) <= 0) {
      throw invalid("glb-empty", "The file has no geometry with a size.");
    }
    const fit = fitScale(size, options.space);
    // Only a model that lies along the wrong axis is turned. One that is about as wide as
    // it is deep (a cabinet) fits a little better either way, and keeps the front it came with.
    if (!best || fit > best.fit * QUARTER_TURN_GAIN) best = { yawDeg, rotation, extent, fit };
  }
  if (!best) throw invalid("glb-empty", "The file has no geometry with a size.");
  if (best.extent.triangles > MAX_ASSET_TRIANGLES) {
    throw invalid(
      "glb-triangles",
      `The model has ${best.extent.triangles} triangles; a catalog asset may have at most ${MAX_ASSET_TRIANGLES}.`,
    );
  }

  const { extent, fit: scale } = best;
  const sourceSize = sizeOf(extent);
  const translation: Vec3 = [
    -((extent.min[0] + extent.max[0]) / 2) * scale,
    -extent.min[1] * scale,
    -((extent.min[2] + extent.max[2]) / 2) * scale,
  ];
  const placing: Mat4 = [scale, 0, 0, 0, 0, scale, 0, 0, 0, 0, scale, 0, ...translation, 1];
  const matrix = multiply(placing, best.rotation).map(round);

  const nodes = [...list(gltf.nodes), { name: "z-factory-normalized", matrix, children: roots }];
  const size: Vec3 = [sourceSize[0] * scale, sourceSize[1] * scale, sourceSize[2] * scale];
  const report: NormalizationReport = {
    upAxis,
    yawDeg: best.yawDeg,
    scale,
    sourceSize,
    size,
    bounds: { min: [-size[0] / 2, 0, -size[2] / 2], max: [size[0] / 2, size[1], size[2] / 2], anchor: [0, 0, 0] },
    vertices: extent.vertices,
    triangles: extent.triangles,
  };
  const normalized: Json = {
    ...gltf,
    nodes,
    scenes: scenes.map((entry, position) =>
      position === sceneIndex ? { ...scene, nodes: [nodes.length - 1] } : entry,
    ),
  };
  return { bytes: writeGlb(normalized, binary), report };
}
