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

/** Version of the envelope and of the payload shapes it carries today. */
export const EVENT_VERSION = 1;

export type EventSeverity = RuntimeEventEnvelope["severity"];

/** An event before it is recorded: identity and time are assigned when it is. */
export type NewRuntimeEvent = {
  type: string;
  factoryId: string;
  deviceId: string | null;
  severity?: EventSeverity;
  payload?: Record<string, unknown>;
};

/**
 * Event families shown as filters. Every event type belongs to exactly one; a type the
 * list does not know is an `OTHER` event, so a new type never disappears from a view.
 */
export const EVENT_FAMILIES = ["LIFECYCLE", "PROGRAM", "DEVICE", "FAULT", "ALARM", "COMMAND", "LINK", "OTHER"] as const;
export type EventFamily = (typeof EVENT_FAMILIES)[number];

const FAMILY_BY_TYPE: Record<string, EventFamily> = {
  FACTORY_CREATED: "LIFECYCLE",
  FACTORY_UPDATED: "LIFECYCLE",
  DEVICE_CREATED: "LIFECYCLE",
  DEVICE_REMOVED: "LIFECYCLE",
  DEVICE_STARTING: "LIFECYCLE",
  DEVICE_RUNNING: "LIFECYCLE",
  DEVICE_STOPPED: "LIFECYCLE",
  DEVICE_FAULTED: "FAULT",
  CONTAINER_EXITED: "LIFECYCLE",
  SIMULATION_STARTED: "LIFECYCLE",
  SIMULATION_STOPPED: "LIFECYCLE",
  PLC_PROGRAM_DEPLOYED: "PROGRAM",
  PLC_PROGRAM_DEPLOY_FAILED: "PROGRAM",
  DEVICE_STATE_CHANGED: "DEVICE",
  VFD_STATE_CHANGED: "DEVICE",
  VFD_COMMAND_CHANGED: "DEVICE",
  MOTOR_STATE_CHANGED: "DEVICE",
  PUMP_STATE_CHANGED: "DEVICE",
  VALVE_STATE_CHANGED: "DEVICE",
  SENSOR_VALUE_CHANGED: "DEVICE",
  DEVICE_RESET: "FAULT",
  FAULT_INJECTED: "FAULT",
  FAULT_CLEARED: "FAULT",
  SIMULATED_INPUT_FORCED: "DEVICE",
  SIMULATED_INPUT_RELEASED: "DEVICE",
  ALARM_RAISED: "ALARM",
  ALARM_ACKNOWLEDGED: "ALARM",
  ALARM_CLEARED: "ALARM",
  COMMAND_ACCEPTED: "COMMAND",
  COMMAND_FAILED: "COMMAND",
  COMMAND_REJECTED: "COMMAND",
  GATEWAY_COMMAND_RECEIVED: "COMMAND",
  CONNECTION_UP: "LINK",
  CONNECTION_DOWN: "LINK",
  TAG_MONITOR_STARTED: "LINK",
  TAG_MONITOR_STOPPED: "LINK",
};

export function eventFamily(type: string): EventFamily {
  return FAMILY_BY_TYPE[type] ?? "OTHER";
}

/** Every type the application emits today, for filters and tests. */
export const KNOWN_EVENT_TYPES: readonly string[] = Object.keys(FAMILY_BY_TYPE);

export function eventTypesOf(family: EventFamily): string[] {
  return KNOWN_EVENT_TYPES.filter((type) => FAMILY_BY_TYPE[type] === family);
}

/** Payload keys that are safe and useful to show, in display order. Anything else stays out of the UI. */
const EVENT_DETAIL_KEYS = [
  "message",
  "name",
  "action",
  "tag",
  "value",
  "source",
  "from",
  "to",
  "version",
  "state",
  "plcStatus",
  "code",
  "rule",
  "warnings",
  "link",
  "by",
] as const;

/** `{ action: "start", code: "RUNTIME_FAILURE" }` → `action start · code RUNTIME_FAILURE`. */
export function eventDetail(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  return EVENT_DETAIL_KEYS.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? [`${key} ${value}`]
      : [];
  }).join(" · ");
}
