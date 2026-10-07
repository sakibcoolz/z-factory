import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { connectivityLimits } from "@/lib/mqtt/boundary";
import { getLatest } from "@/lib/services/telemetry-service";

export const dynamic = "force-dynamic";

/** A PLC's tags with their latest values and projected quality. */
export async function GET(request: Request, { params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  return answer(request, (actor) => getLatest(getDb(), actor, plcId, connectivityLimits()));
}
