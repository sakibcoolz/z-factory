import "server-only";

type Level = "info" | "warn" | "error";

/** Structured logs: one JSON object per line on stdout. Never pass a secret or a password. */
export function log(level: Level, message: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, service: "web-factory", message, ...fields });
  if (level === "error") console.error(line);
  else console.log(line);
}
