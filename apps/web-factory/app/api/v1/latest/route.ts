import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { connectivityLimits } from "@/lib/mqtt/boundary";
import { getLatestInScope } from "@/lib/services/telemetry-service";

export const dynamic = "force-dynamic";

/** Latest values of every PLC in one scope: ?organizationId=, ?siteId= or ?agentId=. */
export async function GET(request: Request) {
  return answer(request, (actor, query) => getLatestInScope(getDb(), actor, query, connectivityLimits()));
}
