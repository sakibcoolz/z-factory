// @vitest-environment node
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { inspectGlb } from "@/lib/assets/glb";
import type { AssetProvider, GenerationRequest, ProviderJob } from "@/lib/assets/meshy";
import { normalizeGlb } from "@/lib/assets/normalize";
import { type AssetStorage, createFileAssetStorage } from "@/lib/assets/storage";
import { loadCatalog } from "@/lib/catalog";
import { ingestCatalog } from "@/lib/catalog/ingest";
import { DomainError, type DomainErrorCode } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import {
  type AuthoringDeps,
  findShareableAsset,
  generateCatalogAsset,
  getAssetPlanEntry,
  importCatalogAsset,
  listAssetPlan,
  previewGeneration,
  resumeCatalogAsset,
  shareCatalogAsset,
} from "@/lib/services/asset-authoring-service";
import {
  activateCatalogAsset,
  failCatalogAssetJob,
  listCatalogAssets,
  openCatalogAssetJob,
  readCatalogAsset,
  recordCatalogAssetJob,
  registerCatalogAsset,
  retireCatalogAsset,
} from "@/lib/services/asset-service";
import { getCatalogModel, getCatalogOverview } from "@/lib/services/catalog-service";
import { createFactory } from "@/lib/services/factory-service";
import { getFactoryScene } from "@/lib/services/scene-service";
import { placeDevice } from "@/lib/services/topology-service";
import { makeBoxGlb } from "../glb";
import { describeDb, openTestDb, resetDb } from "./harness";

/**
 * The authoring path of catalog 3D assets against PostgreSQL and a storage directory,
 * with a provider that is played by the test: from a catalog model to a registered,
 * normalized asset; what a job that fails or is interrupted leaves behind; retiring a
 * version; and what the catalog and a factory scene show of it.
 */
const state = vi.hoisted(() => ({ db: undefined as unknown, storage: undefined as unknown }));

vi.mock("@/lib/db/client", async (original) => ({ ...(await original<object>()), getDb: () => state.db }));
vi.mock("@/lib/auth/actor", () => ({ requireActor: async () => ({ ownerId: "alice" }) }));
vi.mock("@/lib/assets/storage", async (original) => ({
  ...(await original<object>()),
  getAssetStorage: () => state.storage,
}));

const { GET } = await import("@/app/assets/models/[assetId]/[file]/route");

const alice = { ownerId: "alice" };

async function domainError(action: Promise<unknown>, code: DomainErrorCode, rule?: string): Promise<DomainError> {
  const error = await action.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DomainError);
  expect((error as DomainError).code).toBe(code);
  if (rule) expect((error as DomainError).details.rule).toBe(rule);
  return error as DomainError;
}

type Script = {
  /** States the provider reports for a job, in order; the last one repeats. */
  jobs: Record<string, Array<Partial<ProviderJob> | Error>>;
  /** What a download returns, by address. */
  files: Record<string, Uint8Array | Error>;
  startMesh?: Error;
};

/** A provider that follows a script and records what it was asked and what it charged for. */
function fakeProvider(script: Script) {
  const calls: string[] = [];
  const requests: GenerationRequest[] = [];
  let meshes = 0;
  let textures = 0;
  const provider: AssetProvider = {
    name: "MESHY",
    async startMesh(request) {
      calls.push("startMesh");
      if (script.startMesh) throw script.startMesh;
      requests.push(request);
      meshes += 1;
      return `mesh-${meshes}`;
    },
    async startTexture(meshJobId, request) {
      calls.push(`startTexture ${meshJobId}`);
      requests.push(request);
      textures += 1;
      return `texture-${textures}`;
    },
    async getJob(jobId) {
      calls.push(`getJob ${jobId}`);
      const states = script.jobs[jobId] ?? [];
      const next = states.length > 1 ? states.shift() : states[0];
      if (!next) throw new Error(`The script has no state for ${jobId}`);
      if (next instanceof Error) throw next;
      return { id: jobId, status: "SUCCEEDED", progress: 100, message: null, glbUrl: null, ...next };
    },
    async download(url) {
      calls.push(`download ${url}`);
      const file = script.files[url];
      if (!file) throw new Error(`The script has no file at ${url}`);
      if (file instanceof Error) throw file;
      return file;
    },
  };
  return { provider, calls, requests, paidSteps: () => meshes + textures };
}

const URL_1 = "https://assets.meshy.ai/tasks/texture-1/model.glb?Expires=1&Signature=secret-signature";
const unreachable = () =>
  new DomainError("RUNTIME_FAILURE", "Meshy could not be reached.", { rule: "meshy-unreachable" });

describeDb("authoring catalog 3D assets", () => {
  let db: PrismaClient;
  let root: string;
  let storage: AssetStorage;
  const models = { motor: "", conveyor: "", plc: "", plcOther: "", pt420: "", pt010: "", valve: "" };

  const deps = (provider: AssetProvider, extra: Partial<AuthoringDeps> = {}): AuthoringDeps => ({
    db,
    storage,
    provider,
    sleep: async () => undefined,
    ...extra,
  });
  const exists = (key: string) =>
    stat(join(root, key)).then(
      () => true,
      () => false,
    );
  const versions = (deviceModelId: string) => listCatalogAssets(db, deviceModelId);
  const activeId = async (deviceModelId: string) =>
    (await db.deviceModel.findUniqueOrThrow({ where: { id: deviceModelId } })).active3dAssetId;
  const served = async (assetId: string) =>
    (
      await GET(new Request(`http://localhost/assets/models/${assetId}/model.glb`), {
        params: Promise.resolve({ assetId, file: "model.glb" }),
      })
    ).status;

  beforeAll(async () => {
    db = openTestDb();
    state.db = db;
    await resetDb(db);
    await ingestCatalog(db, loadCatalog());
    const id = async (modelName: string) => (await db.deviceModel.findFirstOrThrow({ where: { modelName } })).id;
    models.motor = await id("Generic three-phase motor");
    models.conveyor = await id("Generic belt conveyor");
    models.plc = await id("CPU 1214C DC/DC/DC");
    models.plcOther = await id("TM241CE24T");
    models.pt420 = await id("Generic pressure transmitter, 4–20 mA");
    models.pt010 = await id("Generic pressure transmitter, 0–10 V");
    models.valve = await id("Generic on/off valve, 24 V DC");
  });
  beforeEach(async () => {
    await db.factory.deleteMany();
    await db.catalog3dAsset.deleteMany();
    if (root) await rm(root, { recursive: true, force: true });
    root = await mkdtemp(join(tmpdir(), "zfactory-authoring-"));
    storage = createFileAssetStorage(root);
    state.storage = storage;
  });
  afterAll(async () => {
    await db.catalog3dAsset.deleteMany();
    if (root) await rm(root, { recursive: true, force: true });
    await db.$disconnect();
  });

  it("goes from a catalog model to a registered, normalized asset", async () => {
    // What a provider returns: in its own units, off its origin, lying along the wrong axis.
    const raw = makeBoxGlb({ size: [50, 55, 90], center: [7, 300, -4] });
    const { provider, calls, requests, paidSteps } = fakeProvider({
      jobs: {
        "mesh-1": [
          { status: "PENDING", progress: 0 },
          { status: "IN_PROGRESS", progress: 40 },
          { status: "SUCCEEDED" },
        ],
        "texture-1": [
          { status: "IN_PROGRESS", progress: 70 },
          { status: "SUCCEEDED", glbUrl: URL_1 },
        ],
      },
      files: { [URL_1]: raw },
    });
    const lines: string[] = [];
    const seen: Array<string | null> = [];
    const result = await generateCatalogAsset(
      deps(provider, {
        report: (line) => lines.push(line),
        // What the catalog shows while the job runs.
        sleep: async () => void seen.push((await versions(models.motor))[0]?.providerStatus ?? null),
      }),
      { deviceModelId: models.motor },
    );

    expect(calls).toEqual([
      "startMesh",
      "getJob mesh-1",
      "getJob mesh-1",
      "getJob mesh-1",
      "startTexture mesh-1",
      "getJob texture-1",
      "getJob texture-1",
      `download ${URL_1}`,
    ]);
    expect(paidSteps()).toBe(2);
    expect(requests[0]).toMatchObject({ aiModel: "meshy-6", targetPolycount: 30_000, textured: true });
    expect(requests[0]?.prompt).toContain("three-phase electric motor");
    expect(seen).toEqual(["mesh pending", "mesh in progress 40%", "texture in progress 70%"]);
    expect(lines[0]).toBe("Generic three-phase motor: version 1 requested");

    // Turned a quarter so that it lies along its space, sized to it in metres, standing on its origin.
    expect(result.normalization).toMatchObject({ yawDeg: 90, upAxis: "Y", triangles: 12 });
    expect(result.normalization.size.map((length) => Number(length.toFixed(3)))).toEqual([0.9, 0.55, 0.5]);
    expect(result.asset).toMatchObject({
      deviceModelId: models.motor,
      version: 1,
      status: "READY",
      provider: "MESHY",
      providerJobId: "texture-1",
      providerStatus: "texture succeeded",
      statusMessage: null,
      scale: 1,
      rotationYDeg: 0,
      active: true,
    });

    const row = await db.catalog3dAsset.findUniqueOrThrow({ where: { id: result.asset.id } });
    expect(row.boundsJson).toMatchObject({ anchor: [0, 0, 0] });
    expect(row.validationJson).toMatchObject({ ok: true, normalization: { yawDeg: 90, vertices: 24 } });
    expect(row.generationJson).toMatchObject({
      aiModel: "meshy-6",
      shapeKey: "motor:three-phase motor",
      meshJobId: "mesh-1",
      textureJobId: "texture-1",
    });
    // The signed address of the download is used once and stored nowhere.
    expect(JSON.stringify(row)).not.toMatch(/Signature|secret-signature|assets\.meshy\.ai/);

    // The stored file is the normalized one, in Z-Factory's storage, and it is what is served.
    const stored = await readFile(join(root, `models/${models.motor}/v1/model.glb`));
    expect(stored.byteLength).toBe(result.asset.sizeBytes);
    expect(inspectGlb(stored).counts.nodes).toBe(2);
    expect(normalizeGlb(stored, { space: [0.9, 0.55, 0.5], yawDeg: 0 }).report.scale).toBeCloseTo(1, 6);
    expect((await readCatalogAsset({ db, storage }, result.asset.id)).bytes.equals(stored)).toBe(true);
    expect(await served(result.asset.id)).toBe(200);
  });

  it("generates without a texture when asked, with the options the author gives", async () => {
    const url = "https://assets.meshy.ai/tasks/mesh-1/model.glb";
    const { provider, calls, requests } = fakeProvider({
      jobs: { "mesh-1": [{ status: "SUCCEEDED", glbUrl: url }] },
      files: { [url]: makeBoxGlb({ size: [1, 1, 3] }) },
    });
    const result = await generateCatalogAsset(deps(provider), {
      deviceModelId: models.conveyor,
      textured: false,
      aiModel: "meshy-6-lite",
      targetPolycount: 12_000,
      hint: "with a guard rail on one side",
      yawDeg: 0,
    });
    expect(calls).toEqual(["startMesh", "getJob mesh-1", `download ${url}`]);
    expect(requests[0]).toMatchObject({ aiModel: "meshy-6-lite", targetPolycount: 12_000, textured: false });
    expect(requests[0]?.prompt).toContain("with a guard rail on one side");
    // The author fixed the front: the model is not turned, so its length limits its size.
    expect(result.normalization.yawDeg).toBe(0);
    expect(result.asset).toMatchObject({ providerJobId: "mesh-1", status: "READY" });
  });

  it("records a job the provider fails and leaves the model as it was", async () => {
    const earlier = await registerCatalogAsset(
      { db, storage },
      { deviceModelId: models.motor, provider: "MANUAL" },
      makeBoxGlb(),
    );
    const { provider, paidSteps } = fakeProvider({
      jobs: {
        "mesh-1": [
          { status: "IN_PROGRESS", progress: 10 },
          { status: "FAILED", message: "The prompt was refused." },
        ],
      },
      files: {},
    });
    const error = await domainError(
      generateCatalogAsset(deps(provider), { deviceModelId: models.motor }),
      "RUNTIME_FAILURE",
      "asset-job-failed",
    );
    expect(error.message).toBe("The provider failed the mesh: The prompt was refused.");
    expect(paidSteps()).toBe(1);

    const [failed, kept] = await versions(models.motor);
    expect(failed).toMatchObject({
      version: 2,
      status: "FAILED",
      provider: "MESHY",
      providerJobId: "mesh-1",
      providerStatus: "mesh failed",
      statusMessage: "The provider failed the mesh: The prompt was refused.",
      sizeBytes: null,
      active: false,
    });
    expect(kept).toMatchObject({ id: earlier.id, version: 1, status: "READY", active: true });
    expect(await exists(`models/${models.motor}/v2/model.glb`)).toBe(false);
    expect(await served(failed?.id ?? "")).toBe(404);
    expect(await served(earlier.id)).toBe(200);

    // A failed job does not block the next one, which takes the next version.
    const url = "https://assets.meshy.ai/tasks/mesh-1/model.glb";
    const retry = fakeProvider({ jobs: { "mesh-1": [{ glbUrl: url }] }, files: { [url]: makeBoxGlb() } });
    const next = await generateCatalogAsset(deps(retry.provider), { deviceModelId: models.motor, textured: false });
    expect(next.asset).toMatchObject({ version: 3, status: "READY", active: true });
    expect((await versions(models.motor)).map((asset) => [asset.version, asset.status, asset.active])).toEqual([
      [3, "READY", true],
      [2, "FAILED", false],
      [1, "READY", false],
    ]);
  });

  it("fails a job whose file is not a model the 3D view can load", async () => {
    const cases: Array<[Uint8Array, string, string]> = [
      [new TextEncoder().encode("<html>Access denied</html>"), "glb-format", "The file is not a GLB file."],
      [
        makeBoxGlb({ patch: (gltf) => (gltf.extensionsRequired = ["KHR_draco_mesh_compression"]) }),
        "glb-extension",
        "The file needs KHR_draco_mesh_compression, which the 3D view does not load.",
      ],
      [makeBoxGlb({ size: [0, 0, 0] }), "glb-empty", "The file has no geometry with a size."],
    ];
    for (const [file, rule, message] of cases) {
      await db.catalog3dAsset.deleteMany();
      const { provider } = fakeProvider({ jobs: { "mesh-1": [{ glbUrl: URL_1 }] }, files: { [URL_1]: file } });
      await domainError(
        generateCatalogAsset(deps(provider), { deviceModelId: models.valve, textured: false }),
        "VALIDATION",
        rule,
      );
      expect(await versions(models.valve)).toMatchObject([
        { version: 1, status: "FAILED", statusMessage: message, active: false },
      ]);
      expect(await activeId(models.valve)).toBeNull();
      expect(await exists(`models/${models.valve}/v1/model.glb`)).toBe(false);
    }
  });

  it("records why a job could not even be requested", async () => {
    const { provider } = fakeProvider({
      jobs: {},
      files: {},
      startMesh: new DomainError("RUNTIME_FAILURE", "The Meshy account has too few credits.", {
        rule: "meshy-refused",
        status: 402,
      }),
    });
    await domainError(
      generateCatalogAsset(deps(provider), { deviceModelId: models.valve }),
      "RUNTIME_FAILURE",
      "meshy-refused",
    );
    expect(await versions(models.valve)).toMatchObject([
      { version: 1, status: "FAILED", providerJobId: null, statusMessage: "The Meshy account has too few credits." },
    ]);
  });

  it("leaves an interrupted job pending and resumes it without paying again", async () => {
    const first = fakeProvider({
      jobs: {
        "mesh-1": [{ status: "SUCCEEDED" }],
        "texture-1": [{ status: "IN_PROGRESS", progress: 30 }, unreachable()],
      },
      files: {},
    });
    await domainError(
      generateCatalogAsset(deps(first.provider), { deviceModelId: models.motor }),
      "RUNTIME_FAILURE",
      "meshy-unreachable",
    );
    expect(first.paidSteps()).toBe(2);
    const [pending] = await versions(models.motor);
    expect(pending).toMatchObject({
      version: 1,
      status: "PENDING",
      providerJobId: "texture-1",
      providerStatus: "texture in progress 30%",
      statusMessage: "Generating: texture in progress 30%.",
      active: false,
    });
    expect(await activeId(models.motor)).toBeNull();

    // While it is pending, the same model cannot be requested, and paid for, a second time.
    const blocked = fakeProvider({ jobs: {}, files: {} });
    const conflict = await domainError(
      generateCatalogAsset(deps(blocked.provider), { deviceModelId: models.motor }),
      "CONFLICT",
      "asset-job-pending",
    );
    expect(conflict.details.assetId).toBe(pending?.id);
    expect(blocked.calls).toEqual([]);

    // A step that takes too long is an interruption too, not a failure.
    const slow = fakeProvider({
      jobs: { "mesh-1": [{ status: "SUCCEEDED" }], "texture-1": [{ status: "IN_PROGRESS", progress: 60 }] },
      files: {},
    });
    await domainError(
      resumeCatalogAsset(deps(slow.provider, { timeoutMs: 0 }), pending?.id ?? ""),
      "RUNTIME_FAILURE",
      "asset-job-timeout",
    );
    expect((await versions(models.motor))[0]).toMatchObject({
      status: "PENDING",
      providerStatus: "texture in progress 60%",
    });

    const second = fakeProvider({
      jobs: { "mesh-1": [{ status: "SUCCEEDED" }], "texture-1": [{ status: "SUCCEEDED", glbUrl: URL_1 }] },
      files: { [URL_1]: makeBoxGlb({ size: [2, 1, 1] }) },
    });
    const resumed = await resumeCatalogAsset(deps(second.provider), pending?.id ?? "");
    expect(second.calls).toEqual(["getJob mesh-1", "getJob texture-1", `download ${URL_1}`]);
    expect(second.paidSteps()).toBe(0);
    expect(resumed.asset).toMatchObject({ id: pending?.id, version: 1, status: "READY", active: true });

    await domainError(resumeCatalogAsset(deps(second.provider), pending?.id ?? ""), "CONFLICT", "asset-not-pending");
    await domainError(resumeCatalogAsset(deps(second.provider), "0199a000-0000-7000-8000-00000000dead"), "NOT_FOUND");
    await domainError(resumeCatalogAsset(deps(second.provider), "not-an-id"), "NOT_FOUND");
  });

  it("keeps a paid result whose download failed: the job stays pending and is fetched on resume", async () => {
    const expired = fakeProvider({
      jobs: { "mesh-1": [{ glbUrl: URL_1 }] },
      files: {
        [URL_1]: new DomainError("RUNTIME_FAILURE", "The generated model could not be downloaded (403).", {
          rule: "meshy-download",
        }),
      },
    });
    await domainError(
      generateCatalogAsset(deps(expired.provider), { deviceModelId: models.valve, textured: false }),
      "RUNTIME_FAILURE",
      "meshy-download",
    );
    const [pending] = await versions(models.valve);
    expect(pending).toMatchObject({ status: "PENDING", providerJobId: "mesh-1", providerStatus: "mesh succeeded" });

    const fresh = "https://assets.meshy.ai/tasks/mesh-1/model.glb?Expires=2";
    const again = fakeProvider({ jobs: { "mesh-1": [{ glbUrl: fresh }] }, files: { [fresh]: makeBoxGlb() } });
    const resumed = await resumeCatalogAsset(deps(again.provider), pending?.id ?? "");
    expect(again.calls).toEqual(["getJob mesh-1", `download ${fresh}`]);
    expect(again.paidSteps()).toBe(0);
    expect(resumed.asset).toMatchObject({ version: 1, status: "READY", active: true });
  });

  it("keeps the job states to pending versions", async () => {
    const assetDeps = { db, storage };
    const job = await openCatalogAssetJob(assetDeps, { deviceModelId: models.valve, provider: "MESHY" });
    expect(job).toMatchObject({ version: 1, status: "PENDING", statusMessage: "Generation requested.", active: false });
    await recordCatalogAssetJob(assetDeps, job.id, { providerJobId: "task-9", providerStatus: "mesh in progress 5%" });
    const failed = await failCatalogAssetJob(assetDeps, job.id, "Stopped by the author.");
    expect(failed).toMatchObject({
      status: "FAILED",
      providerJobId: "task-9",
      statusMessage: "Stopped by the author.",
    });

    await domainError(
      recordCatalogAssetJob(assetDeps, job.id, { providerStatus: "x" }),
      "CONFLICT",
      "asset-not-pending",
    );
    await domainError(failCatalogAssetJob(assetDeps, job.id, "again"), "CONFLICT", "asset-not-pending");
    await domainError(
      resumeCatalogAsset(deps(fakeProvider({ jobs: {}, files: {} }).provider), job.id),
      "CONFLICT",
      "asset-not-pending",
    );
    await domainError(
      openCatalogAssetJob(assetDeps, { deviceModelId: "0199a000-0000-7000-8000-00000000dead", provider: "MESHY" }),
      "NOT_FOUND",
    );
    await domainError(openCatalogAssetJob(assetDeps, { deviceModelId: models.valve, provider: "meshy" }), "VALIDATION");

    // A job opened by hand has no stored request and cannot be resumed; it is retired instead.
    const bare = await openCatalogAssetJob(assetDeps, { deviceModelId: models.valve, provider: "MESHY" });
    await domainError(
      resumeCatalogAsset(deps(fakeProvider({ jobs: {}, files: {} }).provider), bare.id),
      "CONFLICT",
      "asset-job-not-resumable",
    );
    const { asset } = await retireCatalogAsset(assetDeps, bare.id, { reason: "Abandoned." });
    expect(asset).toMatchObject({ status: "RETIRED", statusMessage: "Abandoned." });
    expect((await openCatalogAssetJob(assetDeps, { deviceModelId: models.valve, provider: "MESHY" })).version).toBe(3);
  });

  it("imports a file made elsewhere through the same normalization and check", async () => {
    const result = await importCatalogAsset(
      { db, storage },
      {
        deviceModelId: models.plc,
        provider: "MESHY",
        providerJobId: "018a-task",
        generation: { prompt: "A cabinet." },
      },
      makeBoxGlb({ size: [800, 1600, 500], center: [0, 800, 0] }),
    );
    expect(result.asset).toMatchObject({
      version: 1,
      status: "READY",
      provider: "MESHY",
      providerJobId: "018a-task",
      scale: 1,
      active: true,
    });
    expect(result.normalization.scale).toBeCloseTo(0.001, 8);
    const row = await db.catalog3dAsset.findUniqueOrThrow({ where: { id: result.asset.id } });
    expect(row.generationJson).toEqual({ shapeKey: "plc:compact controller", prompt: "A cabinet." });

    // A file that is refused registers nothing and the model keeps what it had.
    await domainError(
      importCatalogAsset({ db, storage }, { deviceModelId: models.plc }, new Uint8Array(40)),
      "VALIDATION",
      "glb-format",
    );
    await domainError(
      importCatalogAsset({ db, storage }, { deviceModelId: models.plc, upAxis: "X" }, makeBoxGlb()),
      "VALIDATION",
    );
    expect(await versions(models.plc)).toHaveLength(1);
    expect(await activeId(models.plc)).toBe(result.asset.id);
    expect(
      (await importCatalogAsset({ db, storage }, { deviceModelId: models.plc }, makeBoxGlb())).asset,
    ).toMatchObject({
      version: 2,
      provider: "MANUAL",
      providerJobId: null,
    });
  });

  it("lets models of one shape share a generated file, each with a version of its own", async () => {
    expect(await findShareableAsset(db, models.pt010)).toBeNull();
    const source = await importCatalogAsset(
      { db, storage },
      { deviceModelId: models.pt420, provider: "MESHY", providerJobId: "task-pt" },
      makeBoxGlb({ size: [2, 7, 2] }),
    );
    expect((await findShareableAsset(db, models.pt010))?.id).toBe(source.asset.id);
    // A level transmitter is another shape; a model does not share with itself.
    expect(await findShareableAsset(db, models.motor)).toBeNull();
    expect(await findShareableAsset(db, models.pt420)).toBeNull();

    const shared = await shareCatalogAsset(
      { db, storage },
      { sourceAssetId: source.asset.id, deviceModelId: models.pt010 },
    );
    expect(shared.asset).toMatchObject({
      deviceModelId: models.pt010,
      version: 1,
      status: "READY",
      provider: "MESHY",
      providerJobId: "task-pt",
      active: true,
    });
    expect(shared.normalization.scale).toBeCloseTo(1, 6);
    expect(await exists(`models/${models.pt010}/v1/model.glb`)).toBe(true);
    const row = await db.catalog3dAsset.findUniqueOrThrow({ where: { id: shared.asset.id } });
    expect(row.generationJson).toMatchObject({ sharedFromAssetId: source.asset.id });

    // Retiring the source does not take the copy away.
    await retireCatalogAsset({ db, storage }, source.asset.id, { purge: true });
    expect(await served(shared.asset.id)).toBe(200);
    await domainError(
      shareCatalogAsset({ db, storage }, { sourceAssetId: source.asset.id, deviceModelId: models.pt010 }),
      "NOT_FOUND",
    );
  });

  it("retires a version: the newest other ready version is rendered, else the generic shape", async () => {
    const assetDeps = { db, storage };
    const register = (size: [number, number, number]) =>
      registerCatalogAsset(assetDeps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb({ size }));
    const v1 = await register([1, 1, 1]);
    const v2 = await register([2, 1, 1]);
    const v3 = await register([3, 1, 1]);
    const factory = await createFactory(db, alice, { name: "Line", slug: "line", subnetCidr: "172.22.9.0/24" });
    const motor = await placeDevice(db, alice, factory.id, { deviceModelId: models.motor, name: "M-01", x: 0, y: 0 });
    const drawn = async () =>
      (await getFactoryScene(db, alice, factory.id)).devices.find((device) => device.id === motor.id)?.asset?.version ??
      null;
    expect(await drawn()).toBe(3);

    // Retiring a version that is not rendered changes nothing for a factory.
    expect((await retireCatalogAsset(assetDeps, v1.id)).activeAssetId).toBe(v3.id);
    expect(await drawn()).toBe(3);
    expect(await exists(`models/${models.motor}/v1/model.glb`)).toBe(true);

    const retired = await retireCatalogAsset(assetDeps, v3.id, { purge: true, reason: "Looked like a product." });
    expect(retired.asset).toMatchObject({ status: "RETIRED", statusMessage: "Looked like a product.", active: false });
    expect(retired.activeAssetId).toBe(v2.id);
    expect(await drawn()).toBe(2);
    expect(await exists(`models/${models.motor}/v3/model.glb`)).toBe(false);
    expect(await served(v3.id)).toBe(404);
    expect(await served(v2.id)).toBe(200);

    expect((await retireCatalogAsset(assetDeps, v2.id)).activeAssetId).toBeNull();
    expect(await drawn()).toBeNull();
    expect(await served(v2.id)).toBe(404);

    // A retired version is not brought back; a regenerated one is a new version.
    await domainError(activateCatalogAsset(assetDeps, v2.id), "CONFLICT", "asset-not-ready");
    await domainError(retireCatalogAsset(assetDeps, "0199a000-0000-7000-8000-00000000dead"), "NOT_FOUND");
    const v4 = await register([4, 1, 1]);
    expect(v4.version).toBe(4);
    expect(await drawn()).toBe(4);
  });

  it("makes an earlier ready version the rendered one again", async () => {
    const assetDeps = { db, storage };
    const v1 = await registerCatalogAsset(assetDeps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb());
    const v2 = await registerCatalogAsset(assetDeps, { deviceModelId: models.motor, provider: "MANUAL" }, makeBoxGlb());
    expect(await activeId(models.motor)).toBe(v2.id);
    expect(await activateCatalogAsset(assetDeps, v1.id)).toMatchObject({ version: 1, active: true });
    expect(await activeId(models.motor)).toBe(v1.id);

    // A record whose file is gone is not made the rendered one.
    await rm(join(root, `models/${models.motor}/v2/model.glb`));
    await domainError(activateCatalogAsset(assetDeps, v2.id), "NOT_FOUND", "asset-file-missing");
    expect(await activeId(models.motor)).toBe(v1.id);
  });

  it("plans the whole catalog: a prompt and a space for every model, and what it has", async () => {
    await importCatalogAsset({ db, storage }, { deviceModelId: models.motor }, makeBoxGlb());
    const plan = await listAssetPlan(db);
    expect(plan).toHaveLength(34);
    expect(new Set(plan.map((entry) => entry.prompt.shapeKey)).size).toBe(29);
    expect(plan.filter((entry) => entry.active).map((entry) => entry.modelName)).toEqual(["Generic three-phase motor"]);
    const plc = plan.find((entry) => entry.deviceModelId === models.plcOther);
    expect(plc).toMatchObject({ categoryCode: "PLC", space: [0.8, 1.6, 0.5], active: null, latest: null });
    expect(plc?.prompt.prompt).not.toMatch(/schneider|modicon|tm241/i);

    const preview = await previewGeneration(db, { deviceModelId: models.plcOther, textured: false });
    expect(preview).toMatchObject({
      credits: 20,
      request: { aiModel: "meshy-6", targetPolycount: 30_000, yawDeg: "auto" },
    });
    expect((await previewGeneration(db, { deviceModelId: models.plcOther })).credits).toBe(30);

    // Words an author adds are checked against every vendor record, whichever model they are for.
    await domainError(
      getAssetPlanEntry(db, models.motor, "like a SIMATIC drive"),
      "VALIDATION",
      "asset-prompt-generic",
    );
    await domainError(
      previewGeneration(db, { deviceModelId: models.plcOther, hint: "a 1214C look" }),
      "VALIDATION",
      "asset-prompt-generic",
    );
    const refused = fakeProvider({ jobs: {}, files: {} });
    await domainError(
      generateCatalogAsset(deps(refused.provider), { deviceModelId: models.plcOther, hint: "CompactLogix style" }),
      "VALIDATION",
      "asset-prompt-generic",
    );
    // Refused before anything is requested or recorded.
    expect(refused.calls).toEqual([]);
    expect(await versions(models.plcOther)).toEqual([]);
    await domainError(previewGeneration(db, { deviceModelId: models.motor, targetPolycount: 5_000_000 }), "VALIDATION");
  });

  it("shows on the catalog where each model's asset stands", async () => {
    const assetDeps = { db, storage };
    const summary = async (deviceModelId: string) =>
      (await getCatalogOverview(db)).manufacturers
        .flatMap((manufacturer) => manufacturer.families.flatMap((family) => family.models))
        .find((model) => model.id === deviceModelId)?.asset;
    expect((await getCatalogOverview(db)).totals).toMatchObject({ models: 34, withAsset: 0 });
    expect(await summary(models.motor)).toEqual({ state: "NONE", activeVersion: null });
    expect(await getCatalogModel(db, models.motor)).toMatchObject({ placeholderKind: "motor", assetVersions: [] });

    const ready = await registerCatalogAsset(
      assetDeps,
      { deviceModelId: models.motor, provider: "MANUAL" },
      makeBoxGlb(),
    );
    expect(await summary(models.motor)).toEqual({ state: "READY", activeVersion: 1 });

    const job = await openCatalogAssetJob(assetDeps, { deviceModelId: models.motor, provider: "MESHY" });
    await recordCatalogAssetJob(assetDeps, job.id, { providerJobId: "task-7", providerStatus: "mesh in progress 20%" });
    expect(await summary(models.motor)).toEqual({ state: "PENDING", activeVersion: 1 });
    await failCatalogAssetJob(assetDeps, job.id, "The provider failed the mesh.");
    expect(await summary(models.motor)).toEqual({ state: "FAILED", activeVersion: 1 });
    await failCatalogAssetJob(
      assetDeps,
      (await openCatalogAssetJob(assetDeps, { deviceModelId: models.valve, provider: "MESHY" })).id,
      "No credits.",
    );
    expect(await summary(models.valve)).toEqual({ state: "FAILED", activeVersion: null });
    expect((await getCatalogOverview(db)).totals.withAsset).toBe(1);

    const detail = await getCatalogModel(db, models.motor);
    expect(detail.asset).toEqual({ state: "FAILED", activeVersion: 1 });
    expect(detail.assetVersions).toMatchObject([
      {
        version: 2,
        status: "FAILED",
        active: false,
        provider: "MESHY",
        providerJobId: "task-7",
        statusMessage: "The provider failed the mesh.",
      },
      { id: ready.id, version: 1, status: "READY", active: true, provider: "MANUAL", sizeBytes: ready.sizeBytes },
    ]);
    expect(detail.assetVersions[0]?.updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    // Once the failed version is retired, the catalog says what is rendered again.
    await retireCatalogAsset(assetDeps, job.id);
    expect(await summary(models.motor)).toEqual({ state: "READY", activeVersion: 1 });
  });
});
