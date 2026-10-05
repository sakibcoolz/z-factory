import "server-only";
import { DomainError } from "@/lib/domain/errors";

/**
 * Reads the container of a binary glTF (GLB) file far enough to say whether the 3D view
 * can load it: a well-formed, self-contained glTF 2.0 file with something to draw. It
 * does not decode geometry or textures. Files come from outside and are untrusted input.
 */

/** Larger files are not catalog assets for a browser scene. */
export const MAX_GLB_BYTES = 25 * 1024 * 1024;

const GLB_MAGIC = 0x46546c67; // "glTF"
const JSON_CHUNK = 0x4e4f534a; // "JSON"
const HEADER_BYTES = 12;
const CHUNK_HEADER_BYTES = 8;

/** Compressions the view does not carry a decoder for; a file that needs one would not render. */
const UNSUPPORTED_EXTENSIONS = ["KHR_draco_mesh_compression", "EXT_meshopt_compression", "KHR_texture_basisu"];

export type GlbInspection = {
  sizeBytes: number;
  generator: string | null;
  counts: { scenes: number; nodes: number; meshes: number; materials: number; textures: number; animations: number };
  /**
   * Box around the vertex positions as the file states them, in file units. Transforms of
   * the nodes are not applied, so it is an estimate; null when the file states none.
   */
  bounds: { min: [number, number, number]; max: [number, number, number] } | null;
};

const invalid = (rule: string, message: string) => new DomainError("VALIDATION", message, { rule });

const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const record = (value: unknown): Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
const vector = (value: unknown): [number, number, number] | null => {
  const numbers = list(value);
  return numbers.length === 3 && numbers.every((item) => typeof item === "number" && Number.isFinite(item))
    ? (numbers as [number, number, number])
    : null;
};

export function inspectGlb(bytes: Uint8Array): GlbInspection {
  if (bytes.byteLength > MAX_GLB_BYTES) {
    throw invalid("glb-size", `The file is larger than ${MAX_GLB_BYTES / (1024 * 1024)} MB.`);
  }
  if (bytes.byteLength < HEADER_BYTES + CHUNK_HEADER_BYTES) throw invalid("glb-format", "The file is not a GLB file.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw invalid("glb-format", "The file is not a GLB file.");
  if (view.getUint32(4, true) !== 2) throw invalid("glb-version", "Only glTF 2.0 files are supported.");
  if (view.getUint32(8, true) !== bytes.byteLength) {
    throw invalid("glb-length", "The file is incomplete or has data after its end.");
  }

  const jsonLength = view.getUint32(HEADER_BYTES, true);
  const jsonStart = HEADER_BYTES + CHUNK_HEADER_BYTES;
  if (view.getUint32(HEADER_BYTES + 4, true) !== JSON_CHUNK || jsonStart + jsonLength > bytes.byteLength) {
    throw invalid("glb-format", "The file does not start with a glTF description.");
  }
  let gltf: Record<string, unknown>;
  try {
    gltf = record(
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(jsonStart, jsonStart + jsonLength))),
    );
  } catch {
    throw invalid("glb-json", "The glTF description in the file cannot be read.");
  }

  const version = record(gltf.asset).version;
  if (typeof version !== "string" || !version.startsWith("2.")) {
    throw invalid("glb-version", "Only glTF 2.0 files are supported.");
  }
  const required = list(gltf.extensionsRequired).filter((name): name is string => typeof name === "string");
  const unsupported = required.find((name) => UNSUPPORTED_EXTENSIONS.includes(name));
  if (unsupported) {
    throw invalid("glb-extension", `The file needs ${unsupported}, which the 3D view does not load.`);
  }
  // A catalog asset is one file: nothing may be fetched from elsewhere when it is rendered.
  const external = [...list(gltf.buffers), ...list(gltf.images)].some((item) => {
    const uri = record(item).uri;
    return typeof uri === "string" && !uri.startsWith("data:");
  });
  if (external)
    throw invalid("glb-external", "The file refers to other files; a catalog asset must be self-contained.");

  const meshes = list(gltf.meshes);
  if (meshes.length === 0 || list(gltf.nodes).length === 0) {
    throw invalid("glb-empty", "The file contains nothing to draw.");
  }

  const accessors = list(gltf.accessors);
  let bounds: GlbInspection["bounds"] = null;
  for (const mesh of meshes) {
    for (const primitive of list(record(mesh).primitives)) {
      const index = record(record(primitive).attributes).POSITION;
      const accessor = typeof index === "number" ? record(accessors[index]) : {};
      const min = vector(accessor.min);
      const max = vector(accessor.max);
      if (!min || !max) continue;
      bounds = bounds
        ? {
            min: bounds.min.map((value, axis) => Math.min(value, min[axis] ?? value)) as [number, number, number],
            max: bounds.max.map((value, axis) => Math.max(value, max[axis] ?? value)) as [number, number, number],
          }
        : { min, max };
    }
  }

  const generator = record(gltf.asset).generator;
  return {
    sizeBytes: bytes.byteLength,
    generator: typeof generator === "string" ? generator.slice(0, 200) : null,
    counts: {
      scenes: list(gltf.scenes).length,
      nodes: list(gltf.nodes).length,
      meshes: meshes.length,
      materials: list(gltf.materials).length,
      textures: list(gltf.textures).length,
      animations: list(gltf.animations).length,
    },
    bounds,
  };
}
