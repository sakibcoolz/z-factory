/**
 * Authoring of catalog 3D assets (TASK-403, docs/device-catalog.md -> 3D assets).
 *
 *   npm run assets -- list
 *   npm run assets -- prompt <model>
 *   npm run assets -- generate <model>... | --missing  [--yes] [--ai-model meshy-6]
 *                     [--polycount 30000] [--no-texture] [--hint "..."] [--up Z] [--yaw 90] [--no-share]
 *   npm run assets -- resume <asset id>
 *   npm run assets -- import <model> --file <file.glb> [--provider MANUAL] [--job <id>] [--up Z] [--yaw 90]
 *   npm run assets -- share <asset id> <model>...
 *   npm run assets -- activate <asset id>
 *   npm run assets -- retire <asset id> [--purge] [--reason "..."]
 *
 * <model> is a catalog model id or its exact name. `generate` spends Meshy credits and
 * does nothing without `--yes`: it prints what it would ask for and what that costs.
 * The key comes from MESHY_API_KEY in the environment and is never printed.
 */
import "dotenv/config";
import { readFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { createMeshyProvider, MESHY_PROVIDER } from "../lib/assets/meshy";
import { getAssetStorage } from "../lib/assets/storage";
import { createPrismaClient } from "../lib/db/client";
import { isDomainError } from "../lib/domain/errors";
import { getServerEnv } from "../lib/env";
import type { PrismaClient } from "../lib/generated/prisma/client";
import {
  type AssetPlanEntry,
  type AuthoringResult,
  findShareableAsset,
  generateCatalogAsset,
  getAssetPlanEntry,
  importCatalogAsset,
  listAssetPlan,
  previewGeneration,
  resumeCatalogAsset,
  shareCatalogAsset,
} from "../lib/services/asset-authoring-service";
import { activateCatalogAsset, type AssetDeps, retireCatalogAsset } from "../lib/services/asset-service";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

class UsageError extends Error {}

const out = (line = "") => console.log(line);

function parse(argv: string[]) {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      yes: { type: "boolean", default: false },
      missing: { type: "boolean", default: false },
      "no-texture": { type: "boolean", default: false },
      "no-share": { type: "boolean", default: false },
      purge: { type: "boolean", default: false },
      "ai-model": { type: "string" },
      polycount: { type: "string" },
      hint: { type: "string" },
      up: { type: "string" },
      yaw: { type: "string" },
      file: { type: "string" },
      provider: { type: "string" },
      job: { type: "string" },
      reason: { type: "string" },
    },
  });
  return { values, command: positionals[0], rest: positionals.slice(1) };
}

type Options = ReturnType<typeof parse>["values"];

function placing(options: Options) {
  const up = options.up?.toUpperCase();
  if (up !== undefined && up !== "Y" && up !== "Z") throw new UsageError("--up is Y or Z.");
  const yaw = options.yaw === undefined || options.yaw === "auto" ? undefined : Number(options.yaw);
  if (yaw !== undefined && !Number.isFinite(yaw)) throw new UsageError("--yaw is a number of degrees or auto.");
  return { ...(up ? { upAxis: up } : {}), ...(yaw === undefined ? {} : { yawDeg: yaw }) };
}

async function resolveModel(plan: AssetPlanEntry[], selector: string): Promise<AssetPlanEntry> {
  const matches = UUID.test(selector)
    ? plan.filter((entry) => entry.deviceModelId === selector.toLowerCase())
    : plan.filter((entry) => entry.modelName.toLowerCase() === selector.toLowerCase());
  if (matches.length === 1 && matches[0]) return matches[0];
  throw new UsageError(
    matches.length === 0
      ? `No catalog model is called "${selector}". Run "npm run assets -- list".`
      : `"${selector}" names ${matches.length} catalog models; use the id.`,
  );
}

const assetText = (entry: AssetPlanEntry) => {
  if (entry.active) return `v${entry.active.version} ready`;
  if (!entry.latest) return "none";
  return `v${entry.latest.version} ${entry.latest.status.toLowerCase()}`;
};

const describe = ({ asset, normalization }: AuthoringResult) =>
  `  v${asset.version} ${asset.status.toLowerCase()} · ${(Number(asset.sizeBytes) / 1e6).toFixed(1)} MB · ` +
  `${normalization.triangles} triangles · ${normalization.size.map((length) => length.toFixed(2)).join(" × ")} m · ` +
  `turned ${normalization.yawDeg}° · asset ${asset.id}`;

async function run(db: PrismaClient, argv: string[]) {
  const { values: options, command, rest } = parse(argv);
  const deps: AssetDeps = { db, storage: getAssetStorage() };
  const plan = await listAssetPlan(db);

  switch (command) {
    case "list": {
      for (const entry of plan) {
        out(
          `${entry.deviceModelId}  ${entry.categoryCode.padEnd(22)} ${assetText(entry).padEnd(12)} ${entry.modelName}`,
        );
        if (entry.latest && entry.latest.status !== "READY" && entry.latest.statusMessage) {
          out(`${" ".repeat(38)}${entry.latest.statusMessage} (asset ${entry.latest.id})`);
        }
      }
      const shapes = new Set(plan.map((entry) => entry.prompt.shapeKey));
      const ready = plan.filter((entry) => entry.active).length;
      out(`\n${plan.length} models, ${shapes.size} distinct shapes, ${ready} with an asset.`);
      return;
    }

    case "prompt": {
      const entry = await getAssetPlanEntry(db, (await resolveModel(plan, rest[0] ?? "")).deviceModelId, options.hint);
      out(`model    ${entry.modelName}`);
      out(`shape    ${entry.prompt.shapeKey}`);
      out(`space    ${entry.space.join(" × ")} m`);
      out(`prompt   ${entry.prompt.prompt}`);
      out(`texture  ${entry.prompt.texturePrompt}`);
      return;
    }

    case "generate": {
      const targets = options.missing
        ? plan.filter((entry) => !entry.active && entry.latest?.status !== "PENDING")
        : await Promise.all(rest.map((selector) => resolveModel(plan, selector)));
      if (targets.length === 0)
        throw new UsageError(options.missing ? "Every model has an asset." : "Name a model, or use --missing.");
      const request = {
        ...(options["ai-model"] ? { aiModel: options["ai-model"] } : {}),
        ...(options.polycount ? { targetPolycount: Number(options.polycount) } : {}),
        textured: !options["no-texture"],
        ...(options.hint ? { hint: options.hint } : {}),
        ...placing(options),
      };

      // A shape is generated once: later models of the same shape take the first one's file.
      const generatedShapes = new Set<string>();
      const steps: Array<{ entry: AssetPlanEntry; action: "generate" | "share"; credits: number }> = [];
      for (const entry of targets) {
        const preview = await previewGeneration(db, { deviceModelId: entry.deviceModelId, ...request });
        // Words the author adds ask for a shape of its own.
        const shared =
          !options["no-share"] &&
          !options.hint &&
          (generatedShapes.has(preview.entry.prompt.shapeKey) ||
            (await findShareableAsset(db, entry.deviceModelId)) !== null);
        generatedShapes.add(preview.entry.prompt.shapeKey);
        steps.push({
          entry: preview.entry,
          action: shared ? "share" : "generate",
          credits: shared ? 0 : preview.credits,
        });
      }
      const credits = steps.reduce((sum, step) => sum + step.credits, 0);
      for (const step of steps) {
        out(`${step.action.padEnd(8)} ${String(step.credits).padStart(3)} credits  ${step.entry.modelName}`);
        if (step.action === "generate") out(`           ${step.entry.prompt.prompt}`);
      }
      const generated = steps.filter((step) => step.action === "generate").length;
      out(`\nAbout ${credits} Meshy credits to generate ${generated} of ${steps.length} models.`);
      if (!options.yes) {
        out("Nothing was requested. Add --yes to generate.");
        return;
      }

      const apiKey = getServerEnv().MESHY_API_KEY;
      if (!apiKey) throw new UsageError("MESHY_API_KEY is not set. Put it in .env (never in Git) to generate.");
      const authoring = { ...deps, provider: createMeshyProvider({ apiKey }), report: out };
      let failed = 0;
      for (const step of steps) {
        try {
          const source = step.action === "share" ? await findShareableAsset(db, step.entry.deviceModelId) : null;
          if (step.action === "share" && !source) {
            out(`${step.entry.modelName}: the model it shares a shape with has no asset; skipped.`);
            failed += 1;
            continue;
          }
          const result = source
            ? await shareCatalogAsset(deps, { sourceAssetId: source.id, deviceModelId: step.entry.deviceModelId })
            : await generateCatalogAsset(authoring, { deviceModelId: step.entry.deviceModelId, ...request });
          out(`${step.entry.modelName}: ${source ? "shared" : "generated"}`);
          out(describe(result));
        } catch (error) {
          if (!isDomainError(error)) throw error;
          failed += 1;
          out(`${step.entry.modelName}: ${error.message}`);
        }
      }
      if (failed > 0) process.exitCode = 1;
      return;
    }

    case "resume": {
      const apiKey = getServerEnv().MESHY_API_KEY;
      if (!apiKey) throw new UsageError("MESHY_API_KEY is not set. Put it in .env (never in Git) to resume a job.");
      out(
        describe(
          await resumeCatalogAsset({ ...deps, provider: createMeshyProvider({ apiKey }), report: out }, rest[0] ?? ""),
        ),
      );
      return;
    }

    case "import": {
      if (!options.file) throw new UsageError("--file <file.glb> is required.");
      const entry = await resolveModel(plan, rest[0] ?? "");
      const provider = options.provider ?? (options.job ? MESHY_PROVIDER : "MANUAL");
      const result = await importCatalogAsset(
        deps,
        {
          deviceModelId: entry.deviceModelId,
          provider,
          ...(options.job ? { providerJobId: options.job } : {}),
          ...(provider === MESHY_PROVIDER
            ? { generation: { prompt: entry.prompt.prompt, texturePrompt: entry.prompt.texturePrompt } }
            : {}),
          ...placing(options),
        },
        await readFile(options.file),
      );
      out(`${entry.modelName}: imported`);
      out(describe(result));
      return;
    }

    case "share": {
      const [sourceAssetId, ...selectors] = rest;
      if (!sourceAssetId || selectors.length === 0) throw new UsageError("share <asset id> <model>...");
      for (const selector of selectors) {
        const entry = await resolveModel(plan, selector);
        const result = await shareCatalogAsset(deps, {
          sourceAssetId,
          deviceModelId: entry.deviceModelId,
          ...placing(options),
        });
        out(`${entry.modelName}: shared`);
        out(describe(result));
      }
      return;
    }

    case "activate": {
      const asset = await activateCatalogAsset(deps, rest[0] ?? "");
      out(`Version ${asset.version} is rendered again.`);
      return;
    }

    case "retire": {
      const { asset, activeAssetId } = await retireCatalogAsset(deps, rest[0] ?? "", {
        purge: options.purge,
        reason: options.reason,
      });
      out(`Version ${asset.version} is retired${options.purge ? " and its file deleted" : ""}.`);
      out(
        activeAssetId
          ? `The model now renders asset ${activeAssetId}.`
          : "The model is drawn as the generic shape of its category.",
      );
      return;
    }

    default:
      throw new UsageError(
        "Commands: list, prompt, generate, resume, import, share, activate, retire. See scripts/catalog-assets.ts.",
      );
  }
}

async function main() {
  const db = createPrismaClient(getServerEnv().DATABASE_URL);
  try {
    await run(db, process.argv.slice(2));
  } catch (error) {
    // Domain messages are written for people; anything else is a defect and keeps its trace.
    if (!(error instanceof UsageError) && !isDomainError(error)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  } finally {
    await db.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
