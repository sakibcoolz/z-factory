import { getAssetStorage } from "@/lib/assets/storage";
import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { readCatalogAsset } from "@/lib/services/asset-service";

/**
 * Serves the GLB of one catalog 3D asset version from Z-Factory's own storage. The 3D
 * view loads models from here and from nowhere else; no generation provider is involved.
 * An asset version never changes, so browsers may keep it.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ assetId: string; file: string }> },
): Promise<Response> {
  const { assetId, file } = await params;
  if (!UUID.test(assetId) || file !== "model.glb") return notFound();

  try {
    await requireActor();
    const { bytes, contentSha256 } = await readCatalogAsset({ db: getDb(), storage: getAssetStorage() }, assetId);
    const etag = `"${contentSha256}"`;
    const headers = {
      "Cache-Control": "private, max-age=31536000, immutable",
      ETag: etag,
      "X-Content-Type-Options": "nosniff",
    };
    if (request.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
    return new Response(new Uint8Array(bytes), {
      headers: { ...headers, "Content-Type": "model/gltf-binary", "Content-Length": String(bytes.byteLength) },
    });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND")) return notFound();
    if (isDomainError(error, "UNAUTHORIZED")) return Response.json({ error: "Not authorized." }, { status: 401 });
    console.error(
      JSON.stringify({
        level: "error",
        action: "asset.read",
        error: isDomainError(error) ? error.message : String(error),
      }),
    );
    return Response.json({ error: "The asset could not be read." }, { status: 500 });
  }
}
