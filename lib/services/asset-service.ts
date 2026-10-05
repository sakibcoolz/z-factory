import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type GlbInspection, inspectGlb } from "@/lib/assets/glb";
import { type AssetStorage, modelAssetKey } from "@/lib/assets/storage";
import { assetRepository } from "@/lib/db/repositories/asset-repository";
import { DomainError } from "@/lib/domain/errors";
import { normalizeDegrees } from "@/lib/domain/scene-view";
import type { PrismaClient } from "@/lib/generated/prisma/client";
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

const registerSchema = z.object({
  deviceModelId: z.uuid(),
  /** Where the file came from, e.g. `MESHY` or `MANUAL`. */
  provider: z.string().regex(/^[A-Z][A-Z0-9_]{1,31}$/, "use an upper-case name such as MESHY or MANUAL"),
  providerJobId: z.string().trim().min(1).max(200).optional(),
  scale: z.number().positive().max(10_000).optional(),
  rotationYDeg: z.number().min(-360).max(360).default(0),
});

export type CatalogAssetView = {
  id: string;
  deviceModelId: string;
  version: number;
  status: "PENDING" | "READY" | "FAILED" | "RETIRED";
  provider: string;
  providerJobId: string | null;
  sizeBytes: number | null;
  contentSha256: string | null;
  scale: number | null;
  rotationYDeg: number;
  active: boolean;
  createdAt: string;
};

type AssetRecord = NonNullable<Awaited<ReturnType<typeof assetRepository.findById>>>;

const toView = (asset: AssetRecord, activeId: string | null): CatalogAssetView => ({
  id: asset.id,
  deviceModelId: asset.deviceModelId,
  version: asset.version,
  status: asset.status,
  provider: asset.provider,
  providerJobId: asset.providerJobId,
  sizeBytes: asset.sizeBytes,
  contentSha256: asset.contentSha256,
  scale: asset.scale,
  rotationYDeg: asset.rotationYDeg,
  active: asset.id === activeId,
  createdAt: asset.createdAt.toISOString(),
});

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
        boundsJson: inspection.bounds ?? undefined,
        validationJson: { ok: true, generator: inspection.generator, counts: inspection.counts },
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
