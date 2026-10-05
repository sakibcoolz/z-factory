/**
 * Builds small binary glTF files for tests: a box with normals and one material, or a
 * file that is broken in a chosen way. Real enough for a glTF loader to draw.
 */

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;

const pad4 = (length: number) => (4 - (length % 4)) % 4;

/** Assembles a GLB container from a glTF description and its binary buffer. */
export function encodeGlb(gltf: unknown, binary: Uint8Array = new Uint8Array(0)): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(gltf));
  const jsonLength = json.length + pad4(json.length);
  const binaryLength = binary.length + pad4(binary.length);
  const total = 12 + 8 + jsonLength + (binary.length > 0 ? 8 + binaryLength : 0);
  const bytes = new Uint8Array(total);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, JSON_CHUNK, true);
  bytes.fill(0x20, 20, 20 + jsonLength);
  bytes.set(json, 20);
  if (binary.length > 0) {
    const start = 20 + jsonLength;
    view.setUint32(start, binaryLength, true);
    view.setUint32(start + 4, BIN_CHUNK, true);
    bytes.set(binary, start + 8);
  }
  return bytes;
}

type BoxOptions = {
  /** Width, height and depth in file units. */
  size?: readonly [number, number, number];
  /** Where the box's centre is in the file: assets do not always sit on their origin. */
  center?: readonly [number, number, number];
  /** Base colour, linear RGB. */
  color?: readonly [number, number, number];
  /** Changes to the glTF description, e.g. to make it invalid. */
  patch?: (gltf: Record<string, unknown>) => void;
};

/** A self-contained GLB of one box: 24 vertices with normals, 36 indices. */
export function makeBoxGlb(options: BoxOptions = {}): Uint8Array {
  const [width, height, depth] = options.size ?? [1, 1, 1];
  const [cx, cy, cz] = options.center ?? [0, 0, 0];
  const faces: Array<{ normal: [number, number, number]; corners: Array<[number, number, number]> }> = [
    {
      normal: [1, 0, 0],
      corners: [
        [1, -1, 1],
        [1, -1, -1],
        [1, 1, -1],
        [1, 1, 1],
      ],
    },
    {
      normal: [-1, 0, 0],
      corners: [
        [-1, -1, -1],
        [-1, -1, 1],
        [-1, 1, 1],
        [-1, 1, -1],
      ],
    },
    {
      normal: [0, 1, 0],
      corners: [
        [-1, 1, 1],
        [1, 1, 1],
        [1, 1, -1],
        [-1, 1, -1],
      ],
    },
    {
      normal: [0, -1, 0],
      corners: [
        [-1, -1, -1],
        [1, -1, -1],
        [1, -1, 1],
        [-1, -1, 1],
      ],
    },
    {
      normal: [0, 0, 1],
      corners: [
        [-1, -1, 1],
        [1, -1, 1],
        [1, 1, 1],
        [-1, 1, 1],
      ],
    },
    {
      normal: [0, 0, -1],
      corners: [
        [1, -1, -1],
        [-1, -1, -1],
        [-1, 1, -1],
        [1, 1, -1],
      ],
    },
  ];
  const positions: number[] = [];
  const normals: number[] = [];
  const indices: number[] = [];
  faces.forEach((face, index) => {
    for (const [x, y, z] of face.corners) {
      positions.push(cx + (x * width) / 2, cy + (y * height) / 2, cz + (z * depth) / 2);
      normals.push(...face.normal);
    }
    const base = index * 4;
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  });

  const vertexBytes = positions.length * 4;
  const binary = new Uint8Array(vertexBytes * 2 + indices.length * 2);
  const view = new DataView(binary.buffer);
  positions.forEach((value, index) => view.setFloat32(index * 4, value, true));
  normals.forEach((value, index) => view.setFloat32(vertexBytes + index * 4, value, true));
  indices.forEach((value, index) => view.setUint16(vertexBytes * 2 + index * 2, value, true));

  const gltf: Record<string, unknown> = {
    asset: { version: "2.0", generator: "z-factory test" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "box" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0, NORMAL: 1 }, indices: 2, material: 0 }] }],
    materials: [
      {
        pbrMetallicRoughness: {
          baseColorFactor: [...(options.color ?? [0.8, 0.5, 0.2]), 1],
          metallicFactor: 0.1,
          roughnessFactor: 0.7,
        },
      },
    ],
    buffers: [{ byteLength: binary.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: vertexBytes, target: 34962 },
      { buffer: 0, byteOffset: vertexBytes, byteLength: vertexBytes, target: 34962 },
      { buffer: 0, byteOffset: vertexBytes * 2, byteLength: indices.length * 2, target: 34963 },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 24,
        type: "VEC3",
        min: [cx - width / 2, cy - height / 2, cz - depth / 2],
        max: [cx + width / 2, cy + height / 2, cz + depth / 2],
      },
      { bufferView: 1, componentType: 5126, count: 24, type: "VEC3" },
      { bufferView: 2, componentType: 5123, count: 36, type: "SCALAR" },
    ],
  };
  options.patch?.(gltf);
  return encodeGlb(gltf, binary);
}
