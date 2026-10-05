import "server-only";
import { DomainError } from "@/lib/domain/errors";

/**
 * Meshy as the provider of generated 3D models (text to 3D). Used only by the authoring
 * path on the server (`scripts/catalog-assets.ts`); no page, route or action imports it,
 * so rendering never depends on it and the key never reaches a browser.
 *
 * The key is sent to the API host only, in the Authorization header. It is not part of
 * any error, log line or stored record.
 */

export const MESHY_PROVIDER = "MESHY";

const API_BASE = "https://api.meshy.ai";
const TEXT_TO_3D = "/openapi/v2/text-to-3d";
/** A download is a file of the provider: nothing else is fetched, whatever a task claims. */
const DOWNLOAD_HOST = /(^|\.)meshy\.ai$/;
/** A model as it comes from the provider may be larger than a catalog asset; far larger is refused unread. */
export const MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024;

export type GenerationRequest = {
  prompt: string;
  texturePrompt: string;
  /** The provider's model name, e.g. `meshy-6`. */
  aiModel: string;
  /** Triangles the provider is asked to reduce the mesh to. */
  targetPolycount: number;
  /** A second, paid step that paints the mesh. Without it the model is plain. */
  textured: boolean;
};

export type ProviderJob = {
  id: string;
  status: "PENDING" | "IN_PROGRESS" | "SUCCEEDED" | "FAILED" | "CANCELED";
  /** 0 to 100. */
  progress: number;
  /** The provider's reason for a failure. */
  message: string | null;
  /** Where the finished GLB can be fetched for a limited time. Never stored. */
  glbUrl: string | null;
};

/** What the authoring path needs from a generation provider; tests supply their own. */
export type AssetProvider = {
  readonly name: string;
  /** Starts the mesh. Costs credits. */
  startMesh(request: GenerationRequest): Promise<string>;
  /** Starts painting a finished mesh. Costs credits. */
  startTexture(meshJobId: string, request: GenerationRequest): Promise<string>;
  getJob(jobId: string): Promise<ProviderJob>;
  download(url: string): Promise<Uint8Array>;
};

/**
 * Credits a generation is expected to cost, from the provider's price list on 2026-10-05
 * (mesh 20, texture 10). An estimate for the person who confirms it, not a bill.
 */
export function estimateCredits(request: Pick<GenerationRequest, "textured">): number {
  return 20 + (request.textured ? 10 : 0);
}

const failure = (message: string, rule: string, details: Record<string, unknown> = {}) =>
  new DomainError("RUNTIME_FAILURE", message, { rule, ...details });

const text = (value: unknown, limit = 300): string | null =>
  typeof value === "string" && value.trim() ? value.trim().slice(0, limit) : null;

const JOB_STATUSES = ["PENDING", "IN_PROGRESS", "SUCCEEDED", "FAILED", "CANCELED"] as const;

type Fetch = typeof fetch;

export function createMeshyProvider(options: { apiKey: string; fetch?: Fetch; baseUrl?: string }): AssetProvider {
  const request = options.fetch ?? fetch;
  const base = options.baseUrl ?? API_BASE;

  async function call(path: string, body?: unknown): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await request(`${base}${path}`, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          Authorization: `Bearer ${options.apiKey}`,
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
      });
    } catch {
      // The cause may quote the request; only the fact is passed on.
      throw failure("Meshy could not be reached.", "meshy-unreachable");
    }
    const payload: unknown = await response.json().catch(() => null);
    const data = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : {};
    if (!response.ok) {
      const reason =
        response.status === 401
          ? "Meshy did not accept the API key."
          : response.status === 402
            ? "The Meshy account has too few credits."
            : response.status === 429
              ? "Meshy is limiting requests; try again later."
              : `Meshy refused the request (${response.status})${text(data.message) ? `: ${text(data.message)}` : "."}`;
      throw failure(reason, "meshy-refused", { status: response.status });
    }
    return data;
  }

  const started = (data: Record<string, unknown>): string => {
    const id = text(data.result, 200);
    if (!id) throw failure("Meshy did not return a task id.", "meshy-response");
    return id;
  };

  return {
    name: MESHY_PROVIDER,

    async startMesh(generation) {
      return started(
        await call(TEXT_TO_3D, {
          mode: "preview",
          prompt: generation.prompt,
          ai_model: generation.aiModel,
          topology: "triangle",
          should_remesh: true,
          target_polycount: generation.targetPolycount,
          target_formats: ["glb"],
        }),
      );
    },

    async startTexture(meshJobId, generation) {
      return started(
        await call(TEXT_TO_3D, {
          mode: "refine",
          preview_task_id: meshJobId,
          ai_model: generation.aiModel,
          // Base colour only: the scene has no environment map for metallic surfaces to reflect.
          enable_pbr: false,
          texture_prompt: generation.texturePrompt,
          target_formats: ["glb"],
        }),
      );
    },

    async getJob(jobId) {
      const data = await call(`${TEXT_TO_3D}/${encodeURIComponent(jobId)}`);
      const status = JOB_STATUSES.find((candidate) => candidate === data.status);
      if (!status) throw failure("Meshy reported a task state Z-Factory does not know.", "meshy-response");
      const urls = typeof data.model_urls === "object" && data.model_urls !== null ? data.model_urls : {};
      const error = typeof data.task_error === "object" && data.task_error !== null ? data.task_error : {};
      return {
        id: jobId,
        status,
        progress: typeof data.progress === "number" ? Math.max(0, Math.min(100, Math.round(data.progress))) : 0,
        message: text((error as Record<string, unknown>).message),
        glbUrl: text((urls as Record<string, unknown>).glb, 4000),
      };
    },

    async download(url) {
      let target: URL;
      try {
        target = new URL(url);
      } catch {
        throw failure("Meshy returned a download address that is not valid.", "meshy-download");
      }
      if (target.protocol !== "https:" || !DOWNLOAD_HOST.test(target.hostname)) {
        throw failure("Meshy returned a download address outside its own hosts.", "meshy-download");
      }
      let response: Response;
      try {
        // No key here: the address is already signed, and the key belongs to the API host only.
        response = await request(target, { redirect: "error", signal: AbortSignal.timeout(120_000) });
      } catch {
        throw failure("The generated model could not be downloaded.", "meshy-download");
      }
      if (!response.ok)
        throw failure(`The generated model could not be downloaded (${response.status}).`, "meshy-download");
      if (Number(response.headers.get("content-length") ?? 0) > MAX_DOWNLOAD_BYTES) {
        throw failure("The generated model is too large to download.", "meshy-download");
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.byteLength > MAX_DOWNLOAD_BYTES) throw failure("The generated model is too large.", "meshy-download");
      return bytes;
    },
  };
}
