import { requireActor } from "@/lib/auth/actor";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { deviceScheduleCsv, ioScheduleCsv, tagScheduleCsv } from "@/lib/export/csv";
import { PLC_EXPORT_FILES, type PlcExportFile } from "@/lib/navigation/routes";
import { buildPlcExport, exportFileStem } from "@/lib/services/plc-export-service";

/**
 * Downloads of the PLC engineering export: the JSON document and the CSV schedules.
 * Same authorization and the same redaction check as the report.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Lets spreadsheet programs read the CSV as UTF-8. */
const BOM = "﻿";

const notFound = () => Response.json({ error: "Not found." }, { status: 404 });

export async function GET(
  request: Request,
  { params }: { params: Promise<{ factoryId: string; plcId: string; file: string }> },
): Promise<Response> {
  const { factoryId, plcId, file } = await params;
  if (!UUID.test(factoryId) || !UUID.test(plcId) || !(PLC_EXPORT_FILES as readonly string[]).includes(file))
    return notFound();

  try {
    const actor = await requireActor();
    const includeRuntime = new URL(request.url).searchParams.get("runtime") === "1";
    const document = await buildPlcExport(getDb(), actor, plcId, { includeRuntime });
    if (document.factory.id !== factoryId) return notFound();

    const body: Record<PlcExportFile, () => string> = {
      "plc.json": () => `${JSON.stringify(document, null, 2)}\n`,
      "io.csv": () => BOM + ioScheduleCsv(document),
      "tags.csv": () => BOM + tagScheduleCsv(document),
      "devices.csv": () => BOM + deviceScheduleCsv(document),
    };
    const name = file as PlcExportFile;
    return new Response(body[name](), {
      headers: {
        "Content-Type": name === "plc.json" ? "application/json; charset=utf-8" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${exportFileStem(document)}-${name === "plc.json" ? "export.json" : name}"`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (error) {
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "INCOMPATIBLE")) return notFound();
    if (isDomainError(error, "UNAUTHORIZED")) return Response.json({ error: "Not authorized." }, { status: 401 });
    // A stopped export says that it was stopped, never why in detail.
    console.error(
      JSON.stringify({
        level: "error",
        action: "plc.export",
        error: isDomainError(error) ? error.message : String(error),
      }),
    );
    return Response.json({ error: "The export could not be produced." }, { status: 500 });
  }
}
