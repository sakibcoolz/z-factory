import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { listCommands } from "@/lib/services/command-service";

export const dynamic = "force-dynamic";

/** A PLC's recent commands, newest first: ?limit= (TASK-905). Sending is a page action only. */
export async function GET(request: Request, { params }: { params: Promise<{ plcId: string }> }) {
  const { plcId } = await params;
  return answer(request, async (actor, query) => ({
    plcId,
    commands: (await listCommands(getDb(), actor, plcId, query)).commands,
  }));
}
