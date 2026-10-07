import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { getConnectionHistory } from "@/lib/services/telemetry-service";

export const dynamic = "force-dynamic";

/** An agent's reported status changes: ?from=&to=&limit=. */
export async function GET(request: Request, { params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;
  return answer(request, (actor, query) => getConnectionHistory(getDb(), actor, agentId, query));
}
