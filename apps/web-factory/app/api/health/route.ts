export const dynamic = "force-dynamic";

/** Liveness: the process answers. It says nothing about the database or MQTT. */
export function GET(): Response {
  return Response.json({ status: "ok", service: "web-factory" }, { headers: { "Cache-Control": "no-store" } });
}
