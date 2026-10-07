/** Starts the broker connection with the server, not on the first page that needs it (TASK-902). */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { getMqttRuntime } = await import("@/lib/mqtt/boundary");
  getMqttRuntime();
}
