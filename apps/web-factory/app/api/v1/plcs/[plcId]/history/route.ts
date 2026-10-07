import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { getTelemetryStore } from "@/lib/mqtt/boundary";
import { getHistory } from "@/lib/services/telemetry-service";

export const dynamic = "force-dynamic";

/** One tag's history: ?tag=&from=&to=&limit=, and &bucket=<seconds> for aggregates. */
export async function GET(request: Request, { params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  return answer(request, (actor, query) => getHistory(getDb(), getTelemetryStore(), actor, plcId, query));
}
