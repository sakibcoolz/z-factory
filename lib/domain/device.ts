/**
 * Device and connection vocabulary (docs/database.md). These mirror the Prisma enums;
 * `lib/domain/enum-parity.test.ts` fails when the two drift apart.
 */

export const PLC_ARCHITECTURES = ["COMPACT", "MODULAR"] as const;
export type PlcArchitecture = (typeof PLC_ARCHITECTURES)[number];

/** PLC point classes: digital/analog input/output. */
export const IO_POINT_TYPES = ["DI", "DO", "AI", "AO"] as const;
export type IoPointType = (typeof IO_POINT_TYPES)[number];

/** Direction of a signal as seen from the peripheral device. */
export const IO_DIRECTIONS = ["INPUT", "OUTPUT"] as const;
export type IoDirection = (typeof IO_DIRECTIONS)[number];

export const IO_SIGNAL_CLASSES = ["DIGITAL", "ANALOG"] as const;
export type IoSignalClass = (typeof IO_SIGNAL_CLASSES)[number];

export const IO_POINT_SOURCES = ["BUILT_IN", "MODULE"] as const;
export type IoPointSource = (typeof IO_POINT_SOURCES)[number];

export const IO_POINT_STATUSES = ["FREE", "OCCUPIED", "RESERVED", "DISABLED"] as const;
export type IoPointStatus = (typeof IO_POINT_STATUSES)[number];

export const CONNECTION_RELATIONSHIPS = [
  "CONTROLS",
  "DRIVES",
  "MECHANICALLY_DRIVES",
  "MEASURES",
  "FEEDS_BACK_TO",
  "COMMUNICATES_WITH",
  "WIRED_TO",
] as const;
export type ConnectionRelationship = (typeof CONNECTION_RELATIONSHIPS)[number];

/**
 * What a terminal of a device is for: one process signal, the supply voltage, the 0 V
 * reference, or protective earth. Only terminals of the same kind are wired together.
 */
export const TERMINAL_KINDS = ["SIGNAL", "POWER", "COMMON", "EARTH"] as const;
export type TerminalKind = (typeof TERMINAL_KINDS)[number];

/** DEVICE_IO is a peripheral terminal (a DeviceIoDefinition of the device's model). */
export const ENDPOINT_TYPES = ["DEVICE", "DEVICE_IO", "PLC_IO_POINT", "TAG", "PROTOCOL_PORT"] as const;
export type EndpointType = (typeof ENDPOINT_TYPES)[number];

/** Category code of PLCs; only PLC models declare an architecture. */
export const PLC_CATEGORY_CODE = "PLC";
export const MOTOR_CATEGORY_CODE = "MOTOR";

/** Categories that can be the target of a DRIVES relationship. */
export const MOTOR_CATEGORY_CODES: readonly string[] = [MOTOR_CATEGORY_CODE, "SERVO_MOTOR"];

/** Categories that can be the source of a DRIVES relationship, with the kind of drive each one is. */
export const DRIVE_TYPE_BY_CATEGORY: Readonly<Record<string, "VFD" | "SERVO" | "SOFT_STARTER">> = {
  VFD: "VFD",
  SERVO_DRIVE: "SERVO",
  SOFT_STARTER: "SOFT_STARTER",
};
export const DRIVE_CATEGORY_CODES: readonly string[] = Object.keys(DRIVE_TYPE_BY_CATEGORY);
