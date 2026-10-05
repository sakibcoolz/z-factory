/** Runtime event envelope (docs/events-telemetry.md). Payload shapes are versioned. */
export type RuntimeEventEnvelope = {
  version: 1;
  id: string;
  type: string;
  factoryId: string;
  deviceId: string | null;
  severity: "INFO" | "WARNING" | "CRITICAL";
  /** ISO-8601. */
  occurredAt: string;
  payload: Record<string, unknown>;
};
