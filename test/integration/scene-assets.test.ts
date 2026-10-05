// @vitest-environment node
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { type AssetStorage, createFileAssetStorage } from "@/lib/assets/storage";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { EMPTY_OPERATION_STATE } from "@/lib/plc/operation-state";
import {
  type AssetDeps,
  listCatalogAssets,
  readCatalogAsset,
  registerCatalogAsset,
} from "@/lib/services/asset-service";
import { createFactory } from "@/lib/services/factory-service";
import { addPeripheral, createPlc } from "@/lib/services/plc-config-service";
import { changeDeviceSceneTransform, getFactoryScene, setDeviceSceneTransform } from "@/lib/services/scene-service";
import { getTopology, linkDevices, placeDevice } from "@/lib/services/topology-service";
import { makeBoxGlb } from "../glb";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * Catalog 3D assets and the 3D view of a factory against PostgreSQL and a storage
 * directory: registering and serving assets, the scene built from the topology, and
 * how an instance is turned and sized.
 */
const state = vi.hoisted(() => ({
  db: undefined as unknown,
  actor: { ownerId: "alice" },
  storage: undefined as unknown,
}));

vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => state.actor }));
vi.mock("@/lib/assets/storage", async (original) => ({
  ...(await original<object>()),
  getAssetStorage: () => state.storage,
}));

const { GET } = await import("@/app/assets/models/[assetId]/[file]/route");
const actions = await import("@/app/factories/[factoryId]/view-3d/actions");

const alice = { ownerId: "alice" };
const bob = { ownerId: "bob" };

async function expectDomainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string) {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
}

describeDb("catalog 3D assets and the factory scene", () => {
  let db: PrismaClient;
  let root: string;
  let storage: AssetStorage;
  let deps: AssetDeps;
  let factoryId: string;
  let plcId: string;
  const ids = { valve: "", motor1: "", motor2: "", pump: "" };
  const models = { valve: "", motor: "", pump: "" };

  const exists = (key: string) =>
    stat(join(root, key)).then(
      () => true,
      () => false,
    );
  const device = async (id: string) =>
    (await getFactoryScene(db, alice, factoryId)).devices.find((candidate) => candidate.id === id);
  const fetchAsset = (assetId: string, file = "model.glb", headers: Record<string, string> = {}) =>
    GET(new Request(`http://localhost/assets/models/${assetId}/${file}`, { headers }), {
      params: Promise.resolve({ assetId, file }),
    });

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    const modelId = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    models.valve = await modelId("Generic on/off valve, 24 V DC");
    models.motor = await modelId("Generic three-phase motor");
    models.pump = await modelId("Generic centrifugal pump");
  });
  beforeEach(async () => {
    state.actor = alice;
    await db.factory.deleteMany();
    await db.catalog3dAsset.deleteMany();
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "zfactory-scene-"));
    storage = createFileAssetStorage(root);
    state.storage = storage;
    deps = { db, storage };

    factoryId = (await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.1.0/24" })).id;
    const plcModel = await db.deviceModel.findFirstOrThrow({ where: { modelName: "CPU 1214C DC/DC/DC" } });
    plcId = (await createPlc(db, alice, { factoryId, deviceModelId: plcModel.id, name: "PLC-01" })).id;
    await addPeripheral(db, alice, plcId, { deviceModelId: models.valve, name: "XV-101" });
    ids.valve = (await db.deviceInstance.findFirstOrThrow({ where: { factoryId, name: "XV-101" } })).id;
    const place = async (deviceModelId: string, name: string, x: number, y: number) =>
      (await placeDevice(db, alice, factoryId, { deviceModelId, name, x, y })).id;
    ids.motor1 = await place(models.motor, "M-01", 300, 60);
    ids.motor2 = await place(models.motor, "M-02", 300, 300);
    ids.pump = await place(models.pump, "P-01", 540, 60);
    await linkDevices(db, alice, factoryId, { fromId: ids.motor1, toId: ids.pump });
  });
  afterAll(async () => {
    await db.catalog3dAsset.deleteMany();
    if (root) await rm(root, { recursive: true, force: true });
    await db.$disconnect();
  });

  it("stores a GLB as a version of the catalog model and makes it the one that is rendered", async () => {
    const glb = makeBoxGlb({ size: [2, 1, 1] });
    const asset = await registerCatalogAsset(
      deps,
      { deviceModelId: models.motor, provider: "MESHY", providerJobId: "task-123", rotationYDeg: -90 },
      glb,
    );
    expect(asset).toMatchObject({
      deviceModelId: models.motor,
      version: 1,
      status: "READY",
      provider: "MESHY",
      providerJobId: "task-123",
      sizeBytes: glb.byteLength,
      scale: null,
      rotationYDeg: 270,
      active: true,
    });
    expect(asset.contentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(asset.inspection.counts.meshes).toBe(1);
    expect(await exists(`models/${models.motor}/v1/model.glb`)).toBe(true);
    expect(new Uint8Array((await readCatalogAsset(deps, asset.id)).bytes)).toEqual(glb);
    const record = await db.catalog3dAsset.findUniqueOrThrow({ where: { id: asset.id } });
    expect(record.boundsJson).toEqual({ min: [-1, -0.5, -0.5], max: [1, 0.5, 0.5] });
    expect(record.validationJson).toMatchObject({ ok: true, generator: "z-factory test" });
  });

  it("keeps earlier versions when an asset is regenerated", async () => {
    const first = await registerCatalogAsset(deps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb());
    const second = await registerCatalogAsset(
      deps,
      { deviceModelId: models.motor, provider: "MESHY", scale: 0.01 },
      makeBoxGlb({ size: [200, 100, 100] }),
    );
    expect(second).toMatchObject({ version: 2, active: true, scale: 0.01 });
    expect((await listCatalogAssets(db, models.motor)).map((asset) => [asset.version, asset.active])).toEqual([
      [2, true],
      [1, false],
    ]);
    // The earlier file is still there and can still be read.
    expect(await exists(`models/${models.motor}/v1/model.glb`)).toBe(true);
    expect((await readCatalogAsset(deps, first.id)).contentSha256).toBe(first.contentSha256);
    expect((await device(ids.motor1))?.asset).toMatchObject({ id: second.id, version: 2, scale: 0.01 });
  });

  it("refuses a file the 3D view could not load and leaves the model as it was", async () => {
    const good = await registerCatalogAsset(deps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb());
    const input = { deviceModelId: models.motor, provider: "MESHY" };

    await expectDomainError(
      registerCatalogAsset(deps, input, new TextEncoder().encode("not a model")),
      "VALIDATION",
      "glb-format",
    );
    await expectDomainError(
      registerCatalogAsset(
        deps,
        input,
        makeBoxGlb({ patch: (gltf) => (gltf.extensionsRequired = ["EXT_meshopt_compression"]) }),
      ),
      "VALIDATION",
      "glb-extension",
    );
    await expectDomainError(registerCatalogAsset(deps, { ...input, provider: "meshy" }, makeBoxGlb()), "VALIDATION");
    await expectDomainError(registerCatalogAsset(deps, { ...input, scale: 0 }, makeBoxGlb()), "VALIDATION");
    await expectDomainError(
      registerCatalogAsset(deps, { ...input, deviceModelId: "018f6f2e-0000-7000-8000-000000000000" }, makeBoxGlb()),
      "NOT_FOUND",
    );

    expect(await listCatalogAssets(db, models.motor)).toEqual([expect.objectContaining({ id: good.id, active: true })]);
    expect(await exists(`models/${models.motor}/v2/model.glb`)).toBe(false);
    await expectDomainError(listCatalogAssets(db, "018f6f2e-0000-7000-8000-000000000000"), "NOT_FOUND");
  });

  it("builds the scene from the topology: the same devices, connections and states", async () => {
    const [scene, topology] = await Promise.all([
      getFactoryScene(db, alice, factoryId),
      getTopology(db, alice, factoryId),
    ]);
    expect(scene.devices.map((item) => item.id)).toEqual(topology.nodes.map((node) => node.id));
    expect(scene.devices.map((item) => [item.name, item.runtimeStatus])).toEqual(
      topology.nodes.map((node) => [node.name, node.runtimeStatus]),
    );
    expect(scene.connections.map((connection) => [connection.id, connection.relationship])).toEqual(
      topology.edges.map((edge) => [edge.id, edge.relationship]),
    );
    expect(scene.connections.find((connection) => connection.sourceId === ids.motor1)).toMatchObject({
      relationship: "MECHANICALLY_DRIVES",
      targetId: ids.pump,
      line: "signal",
    });
    expect(scene.factory).toEqual(topology.factory);

    // A device stands where the designer has it: 240 canvas units are 2 m.
    const motor1 = scene.devices.find((item) => item.id === ids.motor1);
    const motor2 = scene.devices.find((item) => item.id === ids.motor2);
    const pump = scene.devices.find((item) => item.id === ids.pump);
    expect((pump?.position.x ?? 0) - (motor1?.position.x ?? 0)).toBeCloseTo(2);
    expect((motor2?.position.z ?? 0) - (motor1?.position.z ?? 0)).toBeCloseTo(2);
    expect(motor1?.position.z).toBeCloseTo(pump?.position.z ?? Number.NaN);
    expect(scene.extent).toBeGreaterThanOrEqual(4);
    await expectDomainError(getFactoryScene(db, bob, factoryId), "NOT_FOUND");
  });

  it("gives every instance of a model its catalog asset, and the others the shape of their category", async () => {
    const before = await getFactoryScene(db, alice, factoryId);
    expect(before.devices.every((item) => item.asset === null)).toBe(true);
    expect(before.devices.map((item) => [item.name, item.placeholder.kind]).sort()).toEqual([
      ["M-01", "motor"],
      ["M-02", "motor"],
      ["P-01", "pump"],
      ["PLC-01", "cabinet"],
      ["XV-101", "valve"],
    ]);
    expect(before.devices.find((item) => item.id === plcId)).toMatchObject({ isPlc: true, rotationDeg: 0, scale: 1 });

    const asset = await registerCatalogAsset(deps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb());
    const after = await getFactoryScene(db, alice, factoryId);
    const expected = {
      id: asset.id,
      version: 1,
      url: `/assets/models/${asset.id}/model.glb`,
      scale: null,
      rotationYDeg: 0,
    };
    // Both motors are instances of one model: one asset, one URL.
    expect(after.devices.find((item) => item.id === ids.motor1)?.asset).toEqual(expected);
    expect(after.devices.find((item) => item.id === ids.motor2)?.asset).toEqual(expected);
    expect(after.devices.find((item) => item.id === ids.pump)?.asset).toBeNull();
    // The space the asset is fitted into is still the category's.
    expect(after.devices.find((item) => item.id === ids.motor1)?.placeholder).toEqual({
      kind: "motor",
      size: [0.9, 0.55, 0.5],
    });

    // An asset that may no longer be rendered: back to the placeholder, the factory unaffected.
    await db.catalog3dAsset.update({ where: { id: asset.id }, data: { status: "RETIRED" } });
    expect((await device(ids.motor1))?.asset).toBeNull();
    await db.catalog3dAsset.delete({ where: { id: asset.id } });
    expect((await device(ids.motor1))?.asset).toBeNull();
    expect((await db.deviceModel.findUniqueOrThrow({ where: { id: models.motor } })).active3dAssetId).toBeNull();
  });

  it("turns and sizes one instance in the scene and nothing else about the device", async () => {
    const before = await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.motor1 } });

    expect(await setDeviceSceneTransform(db, alice, ids.motor1, { rotationDeg: -90, scale: 2 })).toEqual({
      rotationDeg: 270,
      scale: 2,
    });
    expect(await changeDeviceSceneTransform(db, alice, ids.motor1, { kind: "ROTATE", byDeg: 135 })).toEqual({
      rotationDeg: 45,
      scale: 2,
    });
    expect(await changeDeviceSceneTransform(db, alice, ids.motor1, { kind: "SCALE", factor: 1.25 })).toEqual({
      rotationDeg: 45,
      scale: 2.5,
    });
    // Sizes stop at the limits instead of failing.
    expect(await changeDeviceSceneTransform(db, alice, ids.motor1, { kind: "SCALE", factor: 100 })).toMatchObject({
      scale: 4,
    });
    expect(await changeDeviceSceneTransform(db, alice, ids.motor1, { kind: "SCALE", factor: 0.001 })).toMatchObject({
      scale: 0.25,
    });
    expect(await device(ids.motor1)).toMatchObject({ rotationDeg: 45, scale: 0.25 });
    // The other instance of the same model is not touched.
    expect(await device(ids.motor2)).toMatchObject({ rotationDeg: 0, scale: 1 });

    const after = await db.deviceInstance.findUniqueOrThrow({ where: { id: ids.motor1 } });
    expect({ ...after, sceneRotationDeg: 0, sceneScale: 1, updatedAt: before.updatedAt }).toEqual(before);
    expect(await changeDeviceSceneTransform(db, alice, ids.motor1, { kind: "RESET" })).toEqual({
      rotationDeg: 0,
      scale: 1,
    });

    await expectDomainError(setDeviceSceneTransform(db, alice, ids.motor1, { rotationDeg: 0, scale: 9 }), "VALIDATION");
    await expectDomainError(
      setDeviceSceneTransform(db, alice, ids.motor1, { rotationDeg: Number.NaN, scale: 1 }),
      "VALIDATION",
    );
    await expectDomainError(setDeviceSceneTransform(db, bob, ids.motor1, { rotationDeg: 0, scale: 1 }), "NOT_FOUND");
    await expectDomainError(changeDeviceSceneTransform(db, bob, ids.motor1, { kind: "RESET" }), "NOT_FOUND");
  });

  it("keeps the database from holding an asset or a placing that cannot be rendered", async () => {
    const raw = (sql: string) => db.$executeRawUnsafe(sql);
    await expect(raw(`UPDATE "DeviceInstance" SET "sceneScale" = 0 WHERE id = '${ids.motor1}'`)).rejects.toThrow(
      /scene_transform_check/,
    );
    await expect(
      raw(`UPDATE "DeviceInstance" SET "sceneRotationDeg" = 360 WHERE id = '${ids.motor1}'`),
    ).rejects.toThrow(/scene_transform_check/);
    const insert = (columns: string, values: string) =>
      raw(
        `INSERT INTO "Catalog3dAsset" (id, "deviceModelId", version, provider, "updatedAt"${columns}) VALUES (gen_random_uuid(), '${models.pump}', 1, 'MANUAL', now()${values})`,
      );
    // Ready means there is a file.
    await expect(insert(`, status`, `, 'READY'`)).rejects.toThrow(/ready_file_check/);
    await expect(insert(`, scale`, `, -1`)).rejects.toThrow(/scale_check/);
    await insert("", "");
    await expect(insert("", "")).rejects.toThrow(/deviceModelId_version_key|unique/i);
  });

  it("serves an asset version as an immutable GLB, and nothing that is not one", async () => {
    const glb = makeBoxGlb();
    const asset = await registerCatalogAsset(deps, { deviceModelId: models.valve, provider: "MANUAL" }, glb);

    const response = await fetchAsset(asset.id);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("model/gltf-binary");
    expect(response.headers.get("cache-control")).toBe("private, max-age=31536000, immutable");
    expect(response.headers.get("content-length")).toBe(String(glb.byteLength));
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(glb);
    const etag = response.headers.get("etag") ?? "";
    expect(etag).toBe(`"${asset.contentSha256}"`);
    expect((await fetchAsset(asset.id, "model.glb", { "If-None-Match": etag })).status).toBe(304);

    expect((await fetchAsset(asset.id, "model.gltf")).status).toBe(404);
    expect((await fetchAsset(asset.id, "..%2F..%2Fetc%2Fpasswd")).status).toBe(404);
    expect((await fetchAsset("not-a-uuid")).status).toBe(404);
    expect((await fetchAsset("018f6f2e-0000-7000-8000-000000000000")).status).toBe(404);

    // The record without its file, and an asset that is no longer ready, are not served.
    await rm(join(root, "models"), { recursive: true, force: true });
    expect((await fetchAsset(asset.id)).status).toBe(404);
    await db.catalog3dAsset.update({ where: { id: asset.id }, data: { status: "FAILED" } });
    expect((await fetchAsset(asset.id)).status).toBe(404);
    await expectDomainError(readCatalogAsset(deps, asset.id), "NOT_FOUND");
  });

  it("turns a device through the scene action, by one step from where it is", async () => {
    const act = (deviceId: string, operation: string) => {
      const data = new FormData();
      data.set("deviceId", deviceId);
      data.set("operation", operation);
      return actions.sceneTransformAction(factoryId, EMPTY_OPERATION_STATE, data);
    };
    expect(await act(ids.pump, "rotate-left")).toEqual({ notice: "Turned to 45°, size ×1." });
    expect(await act(ids.pump, "rotate-left")).toEqual({ notice: "Turned to 90°, size ×1." });
    expect(await act(ids.pump, "rotate-right")).toEqual({ notice: "Turned to 45°, size ×1." });
    expect(await act(ids.pump, "scale-up")).toEqual({ notice: "Turned to 45°, size ×1.25." });
    // Up and down again ends where it began.
    expect(await act(ids.pump, "scale-down")).toEqual({ notice: "Turned to 45°, size ×1." });
    expect(await act(ids.pump, "reset")).toEqual({ notice: "Turned to 0°, size ×1." });

    expect(await act(ids.pump, "explode")).toEqual({ message: "Unknown scene operation." });
    expect(await act("not-a-uuid", "reset")).toEqual({ message: "The device does not exist." });
    state.actor = bob;
    expect(await act(ids.pump, "rotate-left")).toEqual({ message: "The device does not exist." });
    expect(await device(ids.pump)).toMatchObject({ rotationDeg: 0, scale: 1 });
  });
});
