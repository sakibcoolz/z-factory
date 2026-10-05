import "server-only";
import { z } from "zod";
import { inspectGlb } from "@/lib/assets/glb";
import { type AssetProvider, estimateCredits, type GenerationRequest, type ProviderJob } from "@/lib/assets/meshy";
import { type NormalizationReport, normalizeGlb } from "@/lib/assets/normalize";
import { type AssetPrompt, buildAssetPrompt, type PromptModel } from "@/lib/assets/prompt";
import { assetRepository } from "@/lib/db/repositories/asset-repository";
import { DomainError, isDomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { placeholderFor } from "@/lib/scene/placeholders";
import { parseInput } from "@/lib/validation/parse";
import {
  type AssetDeps,
  type CatalogAssetView,
  completeCatalogAssetJob,
  failCatalogAssetJob,
  openCatalogAssetJob,
  recordCatalogAssetJob,
  registerCatalogAsset,
  toCatalogAssetView,
} from "./asset-service";

/**
 * Authoring of catalog 3D assets (TASK-403): from a catalog model to a registered asset.
 *
 *   catalog metadata -> prompt -> provider job -> download -> normalize -> check -> register
 *
 * This is work a developer starts on the server, from `scripts/catalog-assets.ts`. No
 * page, route or server action calls it: opening a screen never generates anything and
 * never spends credits. A job is recorded on the asset version while it runs, so a job
 * that was interrupted is resumed, not paid for again.
 */

export type AuthoringDeps = AssetDeps & {
  provider: AssetProvider;
  /** Waits between two questions to the provider; injectable so tests do not wait. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Told what happens, for the person at the terminal. */
  report?: (line: string) => void;
  pollMs?: number;
  /** How long one provider step may take before the job is left pending for a later resume. */
  timeoutMs?: number;
};

const placingOptions = {
  /** Which axis points up in the file the provider returns. */
  upAxis: z.enum(["Y", "Z"]).default("Y"),
  /** Degrees that turn the file's front to the scene's front, or `auto`. */
  yawDeg: z.union([z.literal("auto"), z.number().min(-360).max(360)]).default("auto"),
};

const generateSchema = z.object({
  deviceModelId: z.uuid(),
  aiModel: z
    .string()
    .regex(/^[a-z0-9][a-z0-9.-]{1,31}$/, "use a provider model name such as meshy-6")
    .default("meshy-6"),
  targetPolycount: z.number().int().min(1000).max(100_000).default(30_000),
  textured: z.boolean().default(true),
  /** Words added to the prompt; checked like the prompt itself. */
  hint: z.string().trim().max(200).optional(),
  ...placingOptions,
});

const importSchema = z.object({
  deviceModelId: z.uuid(),
  provider: z.string().default("MANUAL"),
  providerJobId: z.string().optional(),
  generation: z.record(z.string(), z.unknown()).optional(),
  ...placingOptions,
});

const shareSchema = z.object({ sourceAssetId: z.uuid(), deviceModelId: z.uuid(), ...placingOptions });

type AuthoringModel = NonNullable<Awaited<ReturnType<typeof assetRepository.findModelForAuthoring>>>;

/** What is stored about a job so that it can be continued: never an address or a key. */
type StoredGeneration = GenerationRequest & {
  shapeKey: string;
  upAxis: "Y" | "Z";
  yawDeg: number | "auto";
  meshJobId?: string;
  textureJobId?: string;
};

const promptModel = (model: AuthoringModel): PromptModel => ({
  modelName: model.modelName,
  sku: model.sku,
  manufacturer: model.family.manufacturer.name,
  family: model.family.name,
  categoryCode: model.family.category.code,
  categoryName: model.family.category.name,
  architectureType: model.architectureType,
  verificationStatus: model.verificationStatus,
});

async function loadModel(db: PrismaClient, deviceModelId: string): Promise<AuthoringModel> {
  const model = await assetRepository.findModelForAuthoring(db, deviceModelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  return model;
}

export type AssetPlanEntry = {
  deviceModelId: string;
  manufacturer: string;
  modelName: string;
  categoryCode: string;
  /** The space an asset of this model is fitted into, in metres. */
  space: readonly [number, number, number];
  prompt: AssetPrompt;
  /** The version that is rendered, when there is one. */
  active: CatalogAssetView | null;
  /** The newest version, whatever its state. */
  latest: CatalogAssetView | null;
};

const planEntry = (model: AuthoringModel): AssetPlanEntry => {
  const views = model.assets3d.map((asset) => toCatalogAssetView(asset, model.active3dAssetId));
  return {
    deviceModelId: model.id,
    manufacturer: model.family.manufacturer.name,
    modelName: model.modelName,
    categoryCode: model.family.category.code,
    space: placeholderFor(model.family.category.code).size,
    prompt: buildAssetPrompt(promptModel(model)),
    active: views.find((asset) => asset.active && asset.status === "READY") ?? null,
    latest: views[0] ?? null,
  };
};

/** Every catalog model with the prompt its asset would be generated from and the asset it has. */
export async function listAssetPlan(db: PrismaClient): Promise<AssetPlanEntry[]> {
  return (await assetRepository.listModelsForAuthoring(db)).map(planEntry);
}

/**
 * The prompt for a model, with the words an author adds. It is checked against every
 * vendor record of the catalog: a generic shape names none of them.
 */
async function promptFor(db: PrismaClient, model: AuthoringModel, hint?: string): Promise<AssetPrompt> {
  const vendorModels = (await assetRepository.listModelsForAuthoring(db)).map(promptModel);
  return buildAssetPrompt(promptModel(model), { hint, vendorModels });
}

export async function getAssetPlanEntry(
  db: PrismaClient,
  deviceModelId: string,
  hint?: string,
): Promise<AssetPlanEntry> {
  const model = await loadModel(db, deviceModelId);
  return { ...planEntry(model), prompt: await promptFor(db, model, hint) };
}

/**
 * The asset another model of the same shape already renders. Two models that differ only
 * in their electrical data (a 4–20 mA and a 0–10 V transmitter) need one generated file.
 */
export async function findShareableAsset(db: PrismaClient, deviceModelId: string): Promise<CatalogAssetView | null> {
  const plan = await listAssetPlan(db);
  const target = plan.find((entry) => entry.deviceModelId === deviceModelId);
  if (!target) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  const source = plan.find(
    (entry) =>
      entry.deviceModelId !== deviceModelId && entry.prompt.shapeKey === target.prompt.shapeKey && entry.active,
  );
  return source?.active ?? null;
}

/** Normalizes a file for the model's category; the result is in metres, upright, standing on its origin. */
function normalizeFor(model: AuthoringModel, glb: Uint8Array, options: { upAxis: "Y" | "Z"; yawDeg: number | "auto" }) {
  // The file as it came is checked first: normalizing must not be the first thing to read untrusted data.
  inspectGlb(glb);
  return normalizeGlb(glb, { space: placeholderFor(model.family.category.code).size, ...options });
}

/** A normalized file is already sized and turned: the renderer applies nothing on top. */
const placing = (report: NormalizationReport) => ({
  scale: 1,
  rotationYDeg: 0,
  bounds: report.bounds,
  normalization: { ...report },
});

export type AuthoringResult = { asset: CatalogAssetView; normalization: NormalizationReport };

/**
 * Registers a file that exists already (generated in another tool, or made by hand) as
 * the model's next version, normalized and checked like a generated one.
 */
export async function importCatalogAsset(deps: AssetDeps, input: unknown, glb: Uint8Array): Promise<AuthoringResult> {
  const data = parseInput(importSchema, input);
  const model = await loadModel(deps.db, data.deviceModelId);
  const normalized = normalizeFor(model, glb, data);
  const asset = await registerCatalogAsset(
    deps,
    {
      deviceModelId: model.id,
      provider: data.provider,
      providerJobId: data.providerJobId,
      generation: { shapeKey: buildAssetPrompt(promptModel(model)).shapeKey, ...data.generation },
      ...placing(normalized.report),
    },
    normalized.bytes,
  );
  return { asset, normalization: normalized.report };
}

/**
 * Gives a model the file another model already has, fitted into its own category's
 * space. The copy is a version of its own: each model keeps its own record and file.
 */
export async function shareCatalogAsset(deps: AssetDeps, input: unknown): Promise<AuthoringResult> {
  const data = parseInput(shareSchema, input);
  const source = await assetRepository.findById(deps.db, data.sourceAssetId);
  if (!source || source.status !== "READY" || !source.storageKey) {
    throw new DomainError("NOT_FOUND", "The 3D asset to share does not exist or is not ready.");
  }
  return importCatalogAsset(
    deps,
    {
      deviceModelId: data.deviceModelId,
      provider: source.provider,
      providerJobId: source.providerJobId ?? undefined,
      generation: { sharedFromAssetId: source.id },
      upAxis: data.upAxis,
      // The source is normalized already; turning it again is only done when asked for.
      yawDeg: data.yawDeg === "auto" ? 0 : data.yawDeg,
    },
    await deps.storage.read(source.storageKey),
  );
}

const sleepFor = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));

/**
 * Failures after which the job is still worth asking for again: nothing is known to be
 * lost. A download that fails is one of them: the provider still has the paid result and
 * gives a fresh address for it.
 */
const RESUMABLE_RULES = new Set(["meshy-unreachable", "meshy-download", "asset-job-timeout"]);
const resumable = (error: unknown) =>
  isDomainError(error, "RUNTIME_FAILURE") &&
  (RESUMABLE_RULES.has(String(error.details.rule)) ||
    error.details.status === 429 ||
    Number(error.details.status) >= 500);

async function waitForJob(deps: AuthoringDeps, assetId: string, jobId: string, step: string): Promise<ProviderJob> {
  const pollMs = deps.pollMs ?? 5000;
  const deadline = Date.now() + (deps.timeoutMs ?? 20 * 60_000);
  let last = "";
  for (;;) {
    const job = await deps.provider.getJob(jobId);
    const status = `${step} ${job.status.toLowerCase().replace("_", " ")}${job.status === "IN_PROGRESS" ? ` ${job.progress}%` : ""}`;
    if (status !== last) {
      last = status;
      await recordCatalogAssetJob(deps, assetId, { providerStatus: status });
      deps.report?.(`  ${status}`);
    }
    if (job.status === "SUCCEEDED") return job;
    if (job.status === "FAILED" || job.status === "CANCELED") {
      throw new DomainError(
        "RUNTIME_FAILURE",
        `The provider ${job.status === "FAILED" ? "failed" : "cancelled"} the ${step}${job.message ? `: ${job.message}` : "."}`,
        { rule: "asset-job-failed", providerStatus: status },
      );
    }
    if (Date.now() >= deadline) {
      throw new DomainError("RUNTIME_FAILURE", `The ${step} did not finish in time. Resume the job later.`, {
        rule: "asset-job-timeout",
      });
    }
    await (deps.sleep ?? sleepFor)(pollMs);
  }
}

/** Runs a pending job from wherever it stands to a registered asset, or to its failure. */
async function runJob(
  deps: AuthoringDeps,
  assetId: string,
  model: AuthoringModel,
  stored: StoredGeneration,
): Promise<AuthoringResult> {
  const generation = { ...stored };
  const save = (providerJobId: string) => recordCatalogAssetJob(deps, assetId, { providerJobId, generation });
  try {
    if (!generation.meshJobId) {
      generation.meshJobId = await deps.provider.startMesh(generation);
      await save(generation.meshJobId);
      deps.report?.(`  mesh job ${generation.meshJobId}`);
    }
    let job = await waitForJob(deps, assetId, generation.meshJobId, "mesh");
    if (generation.textured) {
      if (!generation.textureJobId) {
        generation.textureJobId = await deps.provider.startTexture(generation.meshJobId, generation);
        await save(generation.textureJobId);
        deps.report?.(`  texture job ${generation.textureJobId}`);
      }
      job = await waitForJob(deps, assetId, generation.textureJobId, "texture");
    }
    if (!job.glbUrl) {
      throw new DomainError("RUNTIME_FAILURE", "The provider finished the job without a GLB file.", {
        rule: "asset-job-failed",
      });
    }
    const normalized = normalizeFor(model, await deps.provider.download(job.glbUrl), generation);
    const asset = await completeCatalogAssetJob(deps, assetId, placing(normalized.report), normalized.bytes);
    return { asset, normalization: normalized.report };
  } catch (error) {
    // An interruption leaves the job pending: its provider ids are stored and `resume` continues it.
    if (resumable(error) || !isDomainError(error)) throw error;
    const providerStatus = typeof error.details.providerStatus === "string" ? error.details.providerStatus : undefined;
    await failCatalogAssetJob(deps, assetId, error.message, providerStatus);
    throw error;
  }
}

/** What a generation would ask for and cost, without asking for it. */
export async function previewGeneration(db: PrismaClient, input: unknown) {
  const data = parseInput(generateSchema, input);
  const entry = await getAssetPlanEntry(db, data.deviceModelId, data.hint);
  return { entry, request: data, credits: estimateCredits(data) };
}

/**
 * Generates an asset for a catalog model with the provider and registers it. Spends the
 * provider's credits: the caller has asked the person who pays.
 */
export async function generateCatalogAsset(deps: AuthoringDeps, input: unknown): Promise<AuthoringResult> {
  const data = parseInput(generateSchema, input);
  const model = await loadModel(deps.db, data.deviceModelId);
  const prompt = await promptFor(deps.db, model, data.hint);
  const generation: StoredGeneration = {
    prompt: prompt.prompt,
    texturePrompt: prompt.texturePrompt,
    shapeKey: prompt.shapeKey,
    aiModel: data.aiModel,
    targetPolycount: data.targetPolycount,
    textured: data.textured,
    upAxis: data.upAxis,
    yawDeg: data.yawDeg,
  };
  const job = await openCatalogAssetJob(deps, { deviceModelId: model.id, provider: deps.provider.name, generation });
  deps.report?.(`${model.modelName}: version ${job.version} requested`);
  return runJob(deps, job.id, model, generation);
}

const storedGenerationSchema = z.object({
  prompt: z.string(),
  texturePrompt: z.string(),
  shapeKey: z.string(),
  aiModel: z.string(),
  targetPolycount: z.number(),
  textured: z.boolean(),
  upAxis: z.enum(["Y", "Z"]),
  yawDeg: z.union([z.literal("auto"), z.number()]),
  meshJobId: z.string().optional(),
  textureJobId: z.string().optional(),
});

/** Continues a pending job with the provider ids it recorded; nothing is requested twice. */
export async function resumeCatalogAsset(deps: AuthoringDeps, assetId: string): Promise<AuthoringResult> {
  const asset = z.uuid().safeParse(assetId).success ? await assetRepository.findById(deps.db, assetId) : null;
  if (!asset) throw new DomainError("NOT_FOUND", "The 3D asset does not exist.");
  if (asset.status !== "PENDING") {
    throw new DomainError("CONFLICT", `Asset version ${asset.version} is ${asset.status.toLowerCase()}, not pending.`, {
      rule: "asset-not-pending",
    });
  }
  const stored = storedGenerationSchema.safeParse(asset.generationJson);
  if (!stored.success) {
    throw new DomainError("CONFLICT", "This job has no stored request to continue. Retire it and generate again.", {
      rule: "asset-job-not-resumable",
    });
  }
  const model = await loadModel(deps.db, asset.deviceModelId);
  deps.report?.(`${model.modelName}: resuming version ${asset.version}`);
  return runJob(deps, asset.id, model, stored.data);
}
