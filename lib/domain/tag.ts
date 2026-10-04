/** Semantic role of a PLC tag (docs/database.md → Tag). */
export const TAG_ROLES = ["COMMAND", "SETPOINT", "FEEDBACK", "STATUS", "ALARM", "PROCESS_VALUE"] as const;

export type TagRole = (typeof TAG_ROLES)[number];

/** Quality carried by every live value (docs/events-telemetry.md → Quality). */
export const TAG_QUALITIES = ["GOOD", "STALE", "BAD", "DISCONNECTED"] as const;

export type TagQuality = (typeof TAG_QUALITIES)[number];

export const TAG_DATA_TYPES = ["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT32"] as const;

export type TagDataType = (typeof TAG_DATA_TYPES)[number];

export const ACCESS_MODES = ["READ_ONLY", "READ_WRITE"] as const;

export type AccessMode = (typeof ACCESS_MODES)[number];

/** Normalized Modbus areas. Display notation (0xxxx/3xxxx/4xxxx) is derived, never stored. */
export const MODBUS_AREAS = ["COIL", "DISCRETE_INPUT", "HOLDING_REGISTER", "INPUT_REGISTER"] as const;

export type ModbusArea = (typeof MODBUS_AREAS)[number];

/**
 * Only command/setpoint tags may be written from the UI or a gateway.
 * Feedback, status, alarm and process values are produced by PLC logic and the
 * device simulators and stay read-only (ADR-0006).
 */
export function isWritableTagRole(role: TagRole): boolean {
  return role === "COMMAND" || role === "SETPOINT";
}

/** Coils and holding registers accept writes; discrete inputs and input registers never do. */
export function isWritableModbusArea(area: ModbusArea): boolean {
  return area === "COIL" || area === "HOLDING_REGISTER";
}

const WORD_COUNT: Record<TagDataType, number> = {
  BOOL: 1,
  INT16: 1,
  UINT16: 1,
  INT32: 2,
  UINT32: 2,
  FLOAT32: 2,
};

/** Number of 16-bit registers a value occupies (a BOOL occupies one coil/discrete input). */
export function wordCountFor(dataType: TagDataType): number {
  return WORD_COUNT[dataType];
}
