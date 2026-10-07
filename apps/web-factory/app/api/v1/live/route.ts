import { auth } from "@/auth";
import { getDb } from "@/lib/db/client";
import { isDomainError } from "@/lib/domain/errors";
import { log } from "@/lib/log";
import { connectivityLimits } from "@/lib/mqtt/boundary";
import { liveView, parseScope } from "@/lib/services/live-service";
import { actorForSession } from "@/lib/services/user-service";

/**
 * Live updates as server-sent events (TASK-904): `?scope=plc:<id>` (or agent:, site:,
 * org:). The view of the scope is built from the database every TICK_MS and sent as a
 * `view` event when it changed; a comment keeps the connection open. The session is
 * checked again every SESSION_CHECK_TICKS, and the view against the actor every time, so a
 * disabled user or a lost membership ends the stream. One direction only.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const TICK_MS = 1_500;
const KEEPALIVE_MS = 15_000;
const SESSION_CHECK_TICKS = 10;

export async function GET(request: Request): Promise<Response> {
  const session = await auth();
  const db = getDb();
  let actor = await actorForSession(db, session?.uid, session?.sv);
  if (!actor) return Response.json({ error: "Sign in first." }, { status: 401 });
  let scope;
  let first: string;
  try {
    scope = parseScope(new URL(request.url).searchParams.get("scope"));
    first = JSON.stringify(await liveView(db, actor, scope, connectivityLimits()));
  } catch (error) {
    if (isDomainError(error, "VALIDATION")) return Response.json({ error: error.message }, { status: 400 });
    if (isDomainError(error, "NOT_FOUND") || isDomainError(error, "FORBIDDEN")) {
      return Response.json({ error: "Not found." }, { status: 404 });
    }
    log("error", "live stream failed", { error: error instanceof Error ? error.name : "unknown" });
    return Response.json({ error: "The live stream could not be opened." }, { status: 500 });
  }

  const encoder = new TextEncoder();
  let closed = false;
  let timer: NodeJS.Timeout | undefined;
  let keepalive: NodeJS.Timeout | undefined;
  let last = first;
  let ticks = 0;
  let controller: ReadableStreamDefaultController<Uint8Array>;
  const close = () => {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    clearInterval(keepalive);
    try {
      controller.close();
    } catch {
      // Already closed by the browser.
    }
  };
  const send = (text: string) => {
    if (closed) return;
    try {
      controller.enqueue(encoder.encode(text));
    } catch {
      close();
    }
  };
  const tick = async () => {
    if (closed) return;
    ticks += 1;
    try {
      if (ticks % SESSION_CHECK_TICKS === 0) {
        actor = await actorForSession(db, session?.uid, session?.sv);
        if (!actor) return close();
      }
      const view = JSON.stringify(await liveView(db, actor!, scope, connectivityLimits()));
      // Only the time changed: nothing to send.
      if (view.replace(/"at":"[^"]*"/, "") !== last.replace(/"at":"[^"]*"/, "")) {
        last = view;
        send(`event: view\ndata: ${view}\n\n`);
      }
    } catch (error) {
      // Access was lost, or the scope is gone: the stream ends.
      if (isDomainError(error)) return close();
      log("warn", "live tick failed", { error: error instanceof Error ? error.name : "unknown" });
    }
    if (!closed) timer = setTimeout(() => void tick(), TICK_MS);
  };

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      send(`retry: 3000\n\nevent: view\ndata: ${first}\n\n`);
      timer = setTimeout(() => void tick(), TICK_MS);
      keepalive = setInterval(() => send(": keepalive\n\n"), KEEPALIVE_MS);
    },
    cancel: close,
  });
  request.signal.addEventListener("abort", close);

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` keeps a proxy from compressing, and so buffering, the stream.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
