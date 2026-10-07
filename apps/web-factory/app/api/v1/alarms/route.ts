import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { listAlarms } from "@/lib/services/alarm-service";

export const dynamic = "force-dynamic";

/**
 * An organization's alarms: ?organizationId=&state=active|history, narrowed by siteId,
 * agentId or plcId; history takes from=&to= (by default the last 7 days) and limit=.
 */
export async function GET(request: Request) {
  return answer(request, async (actor, { organizationId, ...query }) => {
    const { alarms } = await listAlarms(getDb(), actor, organizationId ?? "", query);
    return { organizationId, alarms };
  });
}
