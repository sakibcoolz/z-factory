import { requireActor } from "@/lib/auth/actor";
import { isDomainError } from "@/lib/domain/errors";
import { getGatewayMap } from "@/lib/services/gateway-service";
import { getGatewayDeps } from "@/lib/services/runtime-deps";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ factoryId: string; connectionId: string }> };

/** The register map of one gateway connection: what an edge device is configured from. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { factoryId, connectionId } = await context.params;
  if (!UUID.test(factoryId) || !UUID.test(connectionId)) return new Response(null, { status: 404 });
  try {
    const map = await getGatewayMap(getGatewayDeps(), await requireActor(), connectionId);
    const name = `${map.gateway}-${map.plc}-map.json`.replace(/[^A-Za-z0-9._-]+/g, "_");
    return new Response(`${JSON.stringify(map, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "UNAUTHORIZED")) {
      return new Response(null, { status: 404 });
    }
    throw error;
  }
}
