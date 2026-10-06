import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { exportPlcLink, getPlcLink } from "@/lib/services/plc-communication-service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ factoryId: string; plcId: string; linkId: string }> };

/** A PLC link with its mappings by names (`z-factory.plc-link`), as a download. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { factoryId, plcId, linkId } = await context.params;
  if (![factoryId, plcId, linkId].every((id) => UUID.test(id))) return new Response(null, { status: 404 });
  try {
    const db = getDb();
    const actor = await requireActor();
    const link = await getPlcLink(db, actor, linkId);
    if (link.factoryId !== factoryId || (link.source.plcId !== plcId && link.target.plcId !== plcId)) {
      return new Response(null, { status: 404 });
    }
    const document = await exportPlcLink(db, actor, linkId);
    const name = `${link.source.name}-${link.target.name}-link.json`.replace(/[^A-Za-z0-9._-]+/g, "_");
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": `attachment; filename="${name}"`,
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "UNAUTHORIZED"))
      return new Response(null, { status: 404 });
    throw error;
  }
}
