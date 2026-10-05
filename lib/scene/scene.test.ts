// @vitest-environment node
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inspectGlb, MAX_GLB_BYTES } from "@/lib/assets/glb";
import { type AssetStorage, createFileAssetStorage, modelAssetKey } from "@/lib/assets/storage";
import { GENERIC_CATEGORIES } from "@/lib/catalog/generic-categories";
import { DomainError } from "@/lib/domain/errors";
import { normalizeDegrees, PLACEHOLDER_KINDS } from "@/lib/domain/scene-view";
import { encodeGlb, makeBoxGlb } from "@/test/glb";
import { CANVAS_UNITS_PER_METRE, layoutFloor } from "./layout";
import { DEFAULT_PLACEHOLDER, fitScale, placeholderFor } from "./placeholders";

const rule = (action: () => unknown): string | undefined => {
  try {
    action();
  } catch (error) {
    return error instanceof DomainError ? String(error.details.rule) : `not a domain error: ${String(error)}`;
  }
  return undefined;
};

describe("floor layout", () => {
  it("puts devices on the floor where the designer has them, centred and in metres", () => {
    const { positions, extent } = layoutFloor([
      { x: 60, y: 60 },
      { x: 300, y: 60 },
      { x: 60, y: 300 },
    ]);
    // 240 canvas units apart is 2 m apart; canvas y runs towards the viewer.
    expect(positions).toEqual([
      { x: -1, z: -1 },
      { x: 1, z: -1 },
      { x: -1, z: 1 },
    ]);
    expect(extent).toBe(4);
    expect(CANVAS_UNITS_PER_METRE).toBe(120);
  });

  it("keeps the shape of the layout wherever it sits on the canvas", () => {
    const here = layoutFloor([
      { x: 0, y: 0 },
      { x: 360, y: 120 },
    ]);
    const there = layoutFloor([
      { x: 5000, y: -900 },
      { x: 5360, y: -780 },
    ]);
    expect(there).toEqual(here);
    expect(here.positions).toEqual([
      { x: -1.5, z: -0.5 },
      { x: 1.5, z: 0.5 },
    ]);
  });

  it("gives an empty factory and a single device a floor, and a wide layout a larger one", () => {
    expect(layoutFloor([])).toEqual({ positions: [], extent: 4 });
    expect(layoutFloor([{ x: 777, y: -12 }])).toEqual({ positions: [{ x: 0, z: 0 }], extent: 4 });
    const wide = layoutFloor([
      { x: 0, y: 0 },
      { x: 2400, y: 0 },
    ]);
    // 10 m to each side plus free floor around it.
    expect(wide.extent).toBe(12);
    expect(Object.is(wide.positions[0]?.z, 0)).toBe(true);
  });
});

describe("placeholders", () => {
  it("has a shape with real dimensions for every device category of the catalog", () => {
    for (const category of GENERIC_CATEGORIES) {
      const spec = placeholderFor(category.code);
      expect(spec, category.code).not.toBe(DEFAULT_PLACEHOLDER);
      expect(PLACEHOLDER_KINDS, category.code).toContain(spec.kind);
      for (const length of spec.size) {
        expect(length, category.code).toBeGreaterThan(0);
        expect(length, category.code).toBeLessThanOrEqual(3);
      }
    }
  });

  it("draws a category it does not know as a plain box instead of nothing", () => {
    expect(placeholderFor("FUTURE_PERIPHERAL")).toEqual({ kind: "box", size: [0.6, 0.6, 0.6] });
  });

  it("fits a model into the space of its category without distorting it", () => {
    // A model in millimetres, a metre in centimetres, a model already in metres.
    expect(fitScale([900, 550, 500], [0.9, 0.55, 0.5])).toBeCloseTo(0.001);
    expect(fitScale([100, 100, 100], [0.5, 1.1, 0.4])).toBeCloseTo(0.004);
    expect(fitScale([2, 1, 1], [0.9, 0.55, 0.5])).toBeCloseTo(0.45);
    // A flat or empty model has no size to fit on that axis.
    expect(fitScale([2, 0, 1], [1, 1, 1])).toBeCloseTo(0.5);
    expect(fitScale([0, 0, 0], [1, 1, 1])).toBe(1);
  });

  it("brings any angle into one turn", () => {
    expect([0, 45, 360, 405, -45, -360, 720.5].map(normalizeDegrees)).toEqual([0, 45, 0, 45, 315, 0, 0.5]);
    expect(Object.is(normalizeDegrees(-360), 0)).toBe(true);
  });
});

describe("GLB inspection", () => {
  it("accepts a self-contained glTF 2.0 file and reports what is in it", () => {
    const inspection = inspectGlb(makeBoxGlb({ size: [2, 1, 0.5], center: [10, 0.5, -3] }));
    expect(inspection.counts).toEqual({ scenes: 1, nodes: 1, meshes: 1, materials: 1, textures: 0, animations: 0 });
    expect(inspection.generator).toBe("z-factory test");
    expect(inspection.bounds).toEqual({ min: [9, 0, -3.25], max: [11, 1, -2.75] });
    expect(inspection.sizeBytes).toBeGreaterThan(500);
  });

  it("refuses what is not a complete GLB container", () => {
    const glb = makeBoxGlb();
    expect(rule(() => inspectGlb(new TextEncoder().encode("solid cube\n endsolid")))).toBe("glb-format");
    expect(rule(() => inspectGlb(new Uint8Array(8)))).toBe("glb-format");
    expect(rule(() => inspectGlb(glb.subarray(0, glb.length - 4)))).toBe("glb-length");
    const padded = new Uint8Array(glb.length + 8);
    padded.set(glb);
    expect(rule(() => inspectGlb(padded))).toBe("glb-length");
    const versionOne = glb.slice();
    new DataView(versionOne.buffer).setUint32(4, 1, true);
    expect(rule(() => inspectGlb(versionOne))).toBe("glb-version");
    const brokenJson = glb.slice();
    brokenJson[20] = 0x7d; // the description no longer starts as an object
    expect(rule(() => inspectGlb(brokenJson))).toBe("glb-json");
  });

  it("refuses a file the 3D view could not draw on its own", () => {
    const patched = (patch: (gltf: Record<string, unknown>) => void) => rule(() => inspectGlb(makeBoxGlb({ patch })));
    expect(patched((gltf) => (gltf.asset = { version: "1.0" }))).toBe("glb-version");
    expect(patched((gltf) => (gltf.extensionsRequired = ["KHR_draco_mesh_compression"]))).toBe("glb-extension");
    expect(patched((gltf) => (gltf.extensionsRequired = ["KHR_materials_emissive_strength"]))).toBeUndefined();
    // Anything that would be fetched from somewhere else when the asset is rendered.
    expect(patched((gltf) => (gltf.images = [{ uri: "https://example.com/texture.png" }]))).toBe("glb-external");
    expect(patched((gltf) => (gltf.buffers = [{ uri: "model.bin", byteLength: 4 }]))).toBe("glb-external");
    expect(patched((gltf) => (gltf.images = [{ uri: "data:image/png;base64,AAAA" }]))).toBeUndefined();
    expect(patched((gltf) => (gltf.meshes = []))).toBe("glb-empty");
    expect(rule(() => inspectGlb(encodeGlb({ asset: { version: "2.0" } })))).toBe("glb-empty");
  });

  it("refuses a file beyond the size a catalog asset may have, before reading it", () => {
    expect(rule(() => inspectGlb(new Uint8Array(MAX_GLB_BYTES + 1)))).toBe("glb-size");
  });

  it("reports no bounds when the file states none", () => {
    const inspection = inspectGlb(
      makeBoxGlb({
        patch: (gltf) => {
          const [positions] = gltf.accessors as Array<Record<string, unknown>>;
          delete positions?.min;
        },
      }),
    );
    expect(inspection.bounds).toBeNull();
  });
});

describe("asset storage", () => {
  let root: string;
  let storage: AssetStorage;
  const bytes = makeBoxGlb();

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "zfactory-assets-"));
    storage = createFileAssetStorage(root);
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("stores a file under its key and gives the same bytes back", async () => {
    const key = modelAssetKey("0199B000-0000-7000-8000-00000000000A", 3);
    expect(key).toBe("models/0199b000-0000-7000-8000-00000000000a/v3/model.glb");
    await storage.put(key, bytes);
    expect(new Uint8Array(await storage.read(key))).toEqual(bytes);
    // Nothing but the file is left behind.
    expect(await readdir(join(root, "models/0199b000-0000-7000-8000-00000000000a/v3"))).toEqual(["model.glb"]);

    await storage.remove(key);
    await expect(storage.read(key)).rejects.toMatchObject({
      code: "NOT_FOUND",
      details: { rule: "asset-file-missing" },
    });
    // Removing what is not there is not an error.
    await storage.remove(key);
  });

  it("refuses every key that is not a plain path inside the storage directory", async () => {
    for (const key of [
      "../outside.glb",
      "models/../../etc/passwd",
      "/etc/passwd",
      "models//x.glb",
      "Models/x.glb",
      "",
      "a b",
    ]) {
      await expect(storage.put(key, bytes), key).rejects.toMatchObject({
        code: "INVARIANT",
        details: { rule: "asset-key" },
      });
      await expect(storage.read(key), key).rejects.toMatchObject({ details: { rule: "asset-key" } });
    }
    expect(await readdir(root)).toEqual(["models"]);
  });
});
