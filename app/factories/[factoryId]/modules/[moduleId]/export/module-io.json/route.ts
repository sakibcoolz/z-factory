import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { exportModuleIo } from "@/lib/services/module-io-service";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ factoryId: string; moduleId: string }> };

/** The module's PLC bindings by names (`z-factory.module-io`), as `importModuleIo` reads them back. */
export async function GET(_request: Request, context: Context): Promise<Response> {
  const { factoryId, moduleId } = await context.params;
  if (!UUID.test(factoryId) || !UUID.test(moduleId)) return new Response(null, { status: 404 });
  try {
    const document = await exportModuleIo(getDb(), await requireActor(), moduleId);
    const name = `${document.module.name}-module-io.json`.replace(/[^A-Za-z0-9._-]+/g, "_");
    return new Response(`${JSON.stringify(document, null, 2)}\n`, {
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
