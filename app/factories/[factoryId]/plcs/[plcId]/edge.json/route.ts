import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { edgeDeploymentFileName } from "@/lib/domain/edge-deployment";
import { isDomainError } from "@/lib/domain/errors";
import { exportEdgeDeployment } from "@/lib/services/edge-deployment-service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ factoryId: string; plcId: string }> };

const number = (value: string | null) => (value === null || value === "" ? undefined : Number(value));

/**
 * The PLC's edge deployment for the Thin Client Agent (`zfactory.edge-deployment`), as a
 * download. `host`, `port`, `unitId`, `pollIntervalMs` and `timeoutMs` may be given in the
 * query; the host and port default to the PLC runtime's published Modbus endpoint.
 */
export async function GET(request: Request, context: Context): Promise<Response> {
  const { factoryId, plcId } = await context.params;
  if (![factoryId, plcId].every((id) => UUID.test(id))) return new Response(null, { status: 404 });
  const query = new URL(request.url).searchParams;
  try {
    const db = getDb();
    const actor = await requireActor();
    const document = await exportEdgeDeployment(db, actor, plcId, {
      host: query.get("host") ?? undefined,
      port: number(query.get("port")),
      unitId: number(query.get("unitId")),
      pollIntervalMs: number(query.get("pollIntervalMs")),
      timeoutMs: number(query.get("timeoutMs")),
    });
    if (document.deployment.site.factoryId !== factoryId) return new Response(null, { status: 404 });
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${edgeDeploymentFileName(document.deployment.plc.name)}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "UNAUTHORIZED")) {
      return new Response(null, { status: 404 });
    }
    if (isDomainError(error)) {
      return new Response(JSON.stringify({ error: error.message, rule: error.details.rule ?? null }), {
        status: error.code === "VALIDATION" ? 400 : 409,
        headers: { "Content-Type": "application/json; charset=utf-8" },
      });
    }
    throw error;
  }
}
