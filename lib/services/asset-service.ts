import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type GlbInspection, inspectGlb } from "@/lib/assets/glb";
import { type AssetStorage, modelAssetKey } from "@/lib/assets/storage";
import type { Db } from "@/lib/db/client";
import { assetRepository } from "@/lib/db/repositories/asset-repository";
import { DomainError } from "@/lib/domain/errors";
import { normalizeDegrees } from "@/lib/domain/scene-view";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { parseInput } from "@/lib/validation/parse";

/**
 * Catalog 3D assets: one versioned GLB per catalog model, stored under Z-Factory's
 * control and reused by every factory instance of that model (ADR-0012).
 *
 * An asset belongs to the catalog model, never to a device instance. Registering a file
 * is authoring work done on the server (TASK-403 generates the files); rendering only
 * reads what is stored here and never calls a generation provider.
 */

export type AssetDeps = { db: PrismaClient; storage: AssetStorage };

const vector = z.tuple([z.number(), z.number(), z.number()]);

/** How a stored file stands in a scene and where it came from. */
const placingSchema = z.object({
  scale: z.number().positive().max(10_000).optional(),
  rotationYDeg: z.number().min(-360).max(360).default(0),
  /** Box around the model, when the authoring path measured it. */
  bounds: z.object({ min: vector, max: vector, anchor: vector }).optional(),
  /** What normalization did to the file. */
  normalization: z.record(z.string(), z.unknown()).optional(),
  /** How the file was asked for (prompt, provider model). Never credentials. */
  generation: z.record(z.string(), z.unknown()).optional(),
});

const providerName = z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "use an upper-case name such as MESHY or MANUAL");

const registerSchema = placingSchema.extend({
  deviceModelId: z.uuid(),
  /** Where the file came from, e.g. `MESHY` or `MANUAL`. */
  provider: providerName,
  providerJobId: z.string().trim().min(1).max(200).optional(),
});

const jobSchema = z.object({
  deviceModelId: z.uuid(),
  provider: providerName,
  generation: z.record(z.string(), z.unknown()).optional(),
});

const jobUpdateSchema = z.object({
  providerJobId: z.string().trim().min(1).max(200).optional(),
  providerStatus: z.string().trim().min(1).max(120).optional(),
  generation: z.record(z.string(), z.unknown()).optional(),
});

const message = z.string().trim().min(1).max(500);

export type CatalogAssetStatus = "PENDING" | "READY" | "FAILED" | "RETIRED";

export type CatalogAssetView = {
  id: string;
  deviceModelId: string;
  version: number;
  status: CatalogAssetStatus;
  provider: string;
  providerJobId: string | null;
  /** What the provider last said about the job. */
  providerStatus: string | null;
  /** Why the version is pending, failed or retired. */
  statusMessage: string | null;
  sizeBytes: number | null;
  contentSha256: string | null;
  scale: number | null;
  rotationYDeg: number;
  active: boolean;
  createdAt: string;
  updatedAt: string;
};

type AssetRecord = NonNullable<Awaited<ReturnType<typeof assetRepository.findById>>>;

export const toCatalogAssetView = (asset: AssetRecord, activeId: string | null): CatalogAssetView => ({
  id: asset.id,
  deviceModelId: asset.deviceModelId,
  version: asset.version,
  status: asset.status,
  provider: asset.provider,
  providerJobId: asset.providerJobId,
  providerStatus: asset.providerStatus,
  statusMessage: asset.statusMessage,
  sizeBytes: asset.sizeBytes,
  contentSha256: asset.contentSha256,
  scale: asset.scale,
  rotationYDeg: asset.rotationYDeg,
  active: asset.id === activeId,
  createdAt: asset.createdAt.toISOString(),
  updatedAt: asset.updatedAt.toISOString(),
});

const toView = toCatalogAssetView;

const json = (value: Record<string, unknown> | undefined) => value as Prisma.InputJsonObject | undefined;

/** What the check found, with what normalization did when the authoring path ran it. */
const validationOf = (inspection: GlbInspection, normalization: Record<string, unknown> | undefined) =>
  ({
    ok: true,
    generator: inspection.generator,
    counts: inspection.counts,
    ...(normalization ? { normalization } : {}),
  }) as Prisma.InputJsonObject;

/**
 * Stores a GLB as the next asset version of a catalog model and makes it the one that
 * is rendered. The file is checked first: one that the 3D view could not load is
 * refused and nothing changes, so the model keeps the asset (or placeholder) it had.
 * Earlier versions stay stored.
 */
export async function registerCatalogAsset(
  deps: AssetDeps,
  input: unknown,
  glb: Uint8Array,
): Promise<CatalogAssetView & { inspection: GlbInspection }> {
  const data = parseInput(registerSchema, input);
  const model = await assetRepository.findModel(deps.db, data.deviceModelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  const inspection = inspectGlb(glb);

  const version = await assetRepository.nextVersion(deps.db, model.id);
  const storageKey = modelAssetKey(model.id, version);
  await deps.storage.put(storageKey, glb);
  try {
    const asset = await deps.db.$transaction(async (transaction) => {
      const created = await assetRepository.create(transaction, {
        deviceModelId: model.id,
        version,
        status: "READY",
        storageKey,
        contentSha256: createHash("sha256").update(glb).digest("hex"),
        sizeBytes: glb.byteLength,
        provider: data.provider,
        providerJobId: data.providerJobId ?? null,
        scale: data.scale ?? null,
        rotationYDeg: normalizeDegrees(data.rotationYDeg),
        boundsJson: data.bounds ?? inspection.bounds ?? undefined,
        validationJson: validationOf(inspection, data.normalization),
        generationJson: json(data.generation),
      });
      await assetRepository.setActive(transaction, model.id, created.id);
      return created;
    });
    return { ...toView(asset, asset.id), inspection };
  } catch (error) {
    // The record was not written: the file must not stay behind as an orphan.
    await deps.storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

async function loadAsset(db: PrismaClient, assetId: string): Promise<AssetRecord> {
  const asset = z.uuid().safeParse(assetId).success ? await assetRepository.findById(db, assetId) : null;
  if (!asset) throw new DomainError("NOT_FOUND", "The 3D asset does not exist.");
  return asset;
}

async function loadPending(db: PrismaClient, assetId: string): Promise<AssetRecord> {
  const asset = await loadAsset(db, assetId);
  if (asset.status !== "PENDING") {
    throw new DomainError("CONFLICT", `Asset version ${asset.version} is ${asset.status.toLowerCase()}, not pending.`, {
      rule: "asset-not-pending",
    });
  }
  return asset;
}

const activeIdOf = async (db: Db, deviceModelId: string) =>
  (await db.deviceModel.findUnique({ where: { id: deviceModelId }, select: { active3dAssetId: true } }))
    ?.active3dAssetId ?? null;

/**
 * Opens a generation job: the model's next version, pending and without a file. The
 * model keeps rendering what it rendered. One job per model at a time, so a repeated
 * command cannot pay for the same model twice.
 */
export async function openCatalogAssetJob(deps: AssetDeps, input: unknown): Promise<CatalogAssetView> {
  const data = parseInput(jobSchema, input);
  const model = await assetRepository.findModel(deps.db, data.deviceModelId);
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  const pending = await assetRepository.findPending(deps.db, model.id);
  if (pending) {
    throw new DomainError(
      "CONFLICT",
      `Version ${pending.version} of this model is still being generated. Resume it or retire it first.`,
      { rule: "asset-job-pending", assetId: pending.id },
    );
  }
  const asset = await assetRepository.createPending(deps.db, {
    deviceModelId: model.id,
    version: await assetRepository.nextVersion(deps.db, model.id),
    provider: data.provider,
    statusMessage: "Generation requested.",
    generationJson: json(data.generation),
  });
  return toView(asset, await activeIdOf(deps.db, model.id));
}

/** Records what the provider says about a pending job: its id, its progress. */
export async function recordCatalogAssetJob(
  deps: AssetDeps,
  assetId: string,
  input: unknown,
): Promise<CatalogAssetView> {
  const data = parseInput(jobUpdateSchema, input);
  const pending = await loadPending(deps.db, assetId);
  const asset = await assetRepository.update(deps.db, pending.id, {
    ...(data.providerJobId ? { providerJobId: data.providerJobId } : {}),
    ...(data.providerStatus
      ? { providerStatus: data.providerStatus, statusMessage: `Generating: ${data.providerStatus}.` }
      : {}),
    ...(data.generation ? { generationJson: json(data.generation) } : {}),
  });
  return toView(asset, await activeIdOf(deps.db, asset.deviceModelId));
}

/**
 * Ends a pending job without a file. The version is kept as the record of what failed;
 * the model keeps the asset, or the generic shape, it had.
 */
export async function failCatalogAssetJob(
  deps: AssetDeps,
  assetId: string,
  reason: string,
  providerStatus?: string,
): Promise<CatalogAssetView> {
  const pending = await loadPending(deps.db, assetId);
  const statusMessage = parseInput(message, reason.slice(0, 500));
  const asset = await assetRepository.update(deps.db, pending.id, {
    status: "FAILED",
    statusMessage,
    ...(providerStatus ? { providerStatus: providerStatus.slice(0, 120) } : {}),
    validationJson: { ok: false, message: statusMessage },
  });
  return toView(asset, await activeIdOf(deps.db, asset.deviceModelId));
}

/**
 * Gives a pending job its file: checked like any registered file, stored as the job's
 * version and made the one that is rendered. A file that is refused leaves the job
 * pending for the caller to fail.
 */
export async function completeCatalogAssetJob(
  deps: AssetDeps,
  assetId: string,
  input: unknown,
  glb: Uint8Array,
): Promise<CatalogAssetView & { inspection: GlbInspection }> {
  const data = parseInput(placingSchema, input);
  const pending = await loadPending(deps.db, assetId);
  const inspection = inspectGlb(glb);
  const storageKey = modelAssetKey(pending.deviceModelId, pending.version);
  await deps.storage.put(storageKey, glb);
  try {
    const asset = await deps.db.$transaction(async (transaction) => {
      const updated = await assetRepository.update(transaction, pending.id, {
        status: "READY",
        statusMessage: null,
        storageKey,
        contentSha256: createHash("sha256").update(glb).digest("hex"),
        sizeBytes: glb.byteLength,
        scale: data.scale ?? null,
        rotationYDeg: normalizeDegrees(data.rotationYDeg),
        boundsJson: data.bounds ?? inspection.bounds ?? undefined,
        validationJson: validationOf(inspection, data.normalization),
        ...(data.generation ? { generationJson: json(data.generation) } : {}),
      });
      await assetRepository.setActive(transaction, updated.deviceModelId, updated.id);
      return updated;
    });
    return { ...toView(asset, asset.id), inspection };
  } catch (error) {
    await deps.storage.remove(storageKey).catch(() => undefined);
    throw error;
  }
}

/** Makes an earlier version that is ready the one that is rendered again. */
export async function activateCatalogAsset(deps: AssetDeps, assetId: string): Promise<CatalogAssetView> {
  const asset = await loadAsset(deps.db, assetId);
  if (asset.status !== "READY" || !asset.storageKey) {
    throw new DomainError("CONFLICT", "Only a version that is ready can be rendered.", { rule: "asset-not-ready" });
  }
  // A record whose file is gone would turn every instance into a placeholder.
  await deps.storage.read(asset.storageKey);
  await assetRepository.setActive(deps.db, asset.deviceModelId, asset.id);
  return toView(asset, asset.id);
}

/**
 * Takes a version out of use: it is no longer rendered or served. When it was the one
 * rendered, the newest other version that is ready takes its place; without one the
 * model is drawn as the generic shape of its category. A pending job is abandoned this
 * way. `purge` also deletes the file; the record stays.
 */
export async function retireCatalogAsset(
  deps: AssetDeps,
  assetId: string,
  options: { purge?: boolean; reason?: string } = {},
): Promise<{ asset: CatalogAssetView; activeAssetId: string | null }> {
  const asset = await loadAsset(deps.db, assetId);
  const reason = options.reason === undefined ? "Retired." : parseInput(message, options.reason);
  const purge = options.purge === true && asset.storageKey !== null;

  const result = await deps.db.$transaction(async (transaction) => {
    let activeAssetId = await activeIdOf(transaction, asset.deviceModelId);
    if (activeAssetId === asset.id) {
      activeAssetId = (await assetRepository.latestReady(transaction, asset.deviceModelId, asset.id))?.id ?? null;
      await assetRepository.setActive(transaction, asset.deviceModelId, activeAssetId);
    }
    const retired = await assetRepository.update(transaction, asset.id, {
      status: "RETIRED",
      statusMessage: reason,
      ...(purge ? { storageKey: null } : {}),
    });
    return { asset: toView(retired, activeAssetId), activeAssetId };
  });
  if (purge && asset.storageKey) await deps.storage.remove(asset.storageKey);
  return result;
}

/** Every stored asset version of a catalog model, newest first. */
export async function listCatalogAssets(db: PrismaClient, deviceModelId: string): Promise<CatalogAssetView[]> {
  const model = await db.deviceModel.findUnique({ where: { id: deviceModelId }, select: { active3dAssetId: true } });
  if (!model) throw new DomainError("NOT_FOUND", "The catalog model does not exist.");
  return (await assetRepository.listForModel(db, deviceModelId)).map((asset) => toView(asset, model.active3dAssetId));
}

/**
 * The bytes of an asset version for the renderer. Only a version that is ready is
 * served; a record without its file is reported as missing, not as an error of the caller.
 */
export async function readCatalogAsset(
  deps: AssetDeps,
  assetId: string,
): Promise<{ bytes: Buffer; contentSha256: string }> {
  const asset = await assetRepository.findById(deps.db, assetId);
  if (!asset || asset.status !== "READY" || !asset.storageKey || !asset.contentSha256) {
    throw new DomainError("NOT_FOUND", "The 3D asset does not exist.");
  }
  return { bytes: await deps.storage.read(asset.storageKey), contentSha256: asset.contentSha256 };
}
