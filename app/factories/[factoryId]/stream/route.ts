import { requireActor } from "@/lib/auth/actor";
import { isDomainError } from "@/lib/domain/errors";
import { HEARTBEAT_INTERVAL_MS, type LiveMessage } from "@/lib/domain/live";
import { encodeSse, sseRetry } from "@/lib/events/sse";
import { openLiveStream } from "@/lib/services/live-service";
import { getLiveDeps } from "@/lib/services/runtime-deps";

/**
 * The live channel of a factory as server-sent events: recorded events, tag values and,
 * on every (re)connect, the current state. One direction only; commands go through
 * server actions. Same authorization as the factory's screens.
 */

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function GET(request: Request, { params }: { params: Promise<{ factoryId: string }> }): Promise<Response> {
  const { factoryId } = await params;
  if (!UUID.test(factoryId)) return Response.json({ error: "Not found." }, { status: 404 });

  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  let unsubscribe: (() => void) | undefined;
  let closed = false;

  function close() {
    if (closed) return;
    closed = true;
    clearInterval(heartbeat);
    unsubscribe?.();
    try {
      controller?.close();
    } catch {
      // Already closed by the client.
    }
  }
  function send(message: LiveMessage) {
    if (closed) return;
    try {
      controller?.enqueue(encoder.encode(encodeSse(message)));
    } catch {
      close();
    }
  }
  const heartbeat = setInterval(() => send({ kind: "heartbeat", at: new Date().toISOString() }), HEARTBEAT_INTERVAL_MS);

  const stream = new ReadableStream<Uint8Array>({
    start(streamController) {
      controller = streamController;
      streamController.enqueue(encoder.encode(sseRetry()));
    },
    cancel: close,
  });

  try {
    const actor = await requireActor();
    // A browser resumes with the header; the query parameter serves clients that cannot set one.
    const lastEventId = request.headers.get("last-event-id") ?? new URL(request.url).searchParams.get("lastEventId");
    unsubscribe = await openLiveStream(getLiveDeps(), actor, factoryId, lastEventId, send);
  } catch (error) {
    close();
    if (isDomainError(error, "NOT_FOUND")) return Response.json({ error: "Not found." }, { status: 404 });
    if (isDomainError(error, "UNAUTHORIZED")) return Response.json({ error: "Not authorized." }, { status: 401 });
    console.error(
      JSON.stringify({
        level: "error",
        action: "factory.stream",
        error: isDomainError(error) ? error.message : String(error),
      }),
    );
    return Response.json({ error: "The live stream could not be opened." }, { status: 500 });
  }

  request.signal.addEventListener("abort", close);
  if (request.signal.aborted) close();

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      // `no-transform` also keeps the response from being compressed and thereby buffered.
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
