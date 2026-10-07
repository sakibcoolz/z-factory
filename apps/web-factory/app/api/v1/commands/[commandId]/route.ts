import { answer } from "@/lib/api";
import { getDb } from "@/lib/db/client";
import { getCommand } from "@/lib/services/command-service";

export const dynamic = "force-dynamic";

/** One command: who, what, its status, the agent's answer and the telemetry that confirmed it. */
export async function GET(request: Request, { params }: { params: Promise<{ commandId: string }> }) {
  const { commandId } = await params;
  return answer(request, (actor) => getCommand(getDb(), actor, commandId));
}
