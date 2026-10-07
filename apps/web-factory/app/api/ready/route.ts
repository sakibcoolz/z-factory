import { getDb } from "@/lib/db/client";
import { log } from "@/lib/log";
import { brokerStatus } from "@/lib/mqtt/boundary";

export const dynamic = "force-dynamic";

/**
 * Readiness: the database answers and holds the schema. The broker connection is reported
 * but does not fail readiness: the pages still work, and say statuses may be out of date.
 * Nothing about the broker but its state is shown here (the endpoint is public).
 */
export async function GET(): Promise<Response> {
  const headers = { "Cache-Control": "no-store" };
  const broker = brokerStatus();
  const mqtt = !broker.configured ? "not-configured" : broker.connected ? "connected" : "disconnected";
  // Telemetry waiting to be written: "backlogged" past 80 % of the queue (TASK-903).
  const telemetry = !broker.configured
    ? "not-configured"
    : broker.telemetry.queued > broker.telemetry.capacity * 0.8
      ? "backlogged"
      : "ok";
  try {
    await getDb().organization.count();
    return Response.json({ status: "ready", checks: { database: "ok", mqtt, telemetry } }, { headers });
  } catch (error) {
    log("error", "readiness check failed", {
      check: "database",
      error: error instanceof Error ? error.name : "unknown",
    });
    return Response.json(
      { status: "not-ready", checks: { database: "failed", mqtt, telemetry } },
      { status: 503, headers },
    );
  }
}
