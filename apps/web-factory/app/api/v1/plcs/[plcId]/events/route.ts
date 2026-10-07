import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { getPlcEvents } from "@/lib/services/telemetry-service";

export const dynamic = "force-dynamic";

/** A PLC's state and tag quality changes: ?from=&to=&limit=&kind=PLC_STATE|TAG_QUALITY. */
export async function GET(request: Request, { params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  return answer(request, (actor, query) => getPlcEvents(getDb(), actor, plcId, query));
}
