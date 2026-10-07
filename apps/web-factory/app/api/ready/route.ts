import { getDb } from "@/lib/db/client";
import { log } from "@/lib/log";

export const dynamic = "force-dynamic";

/** Readiness: the database answers and holds the schema. MQTT joins in TASK-902. */
export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  try {
    await getDb().organization.count();
    return Response.json({ status: "ready", checks: { database: "ok" } }, { headers });
  } catch (error) {
    log("error", "readiness check failed", {
      check: "database",
      error: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ status: "not-ready", checks: { database: "failed" } }, { status: 503, headers });
  }
}
