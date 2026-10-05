/**
 * Zod schemas for untrusted input at the application boundary (forms, server actions,
 * route handlers, imports). Services parse with these before touching the database.
 */
import { z } from "zod";
import { CONNECTION_RELATIONSHIPS, ENDPOINT_TYPES } from "@/lib/domain/device";
import { TAG_DATA_TYPES, TAG_ROLES } from "@/lib/domain/tag";
import { ipv4ToInt, maskFor } from "./network";

const trimmed = (max: number) => z.string().trim().min(1).max(max);

export const slugSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "Use lowercase letters, digits and single hyphens.");

const PRIVATE_RANGES: ReadonlyArray<readonly [network: number, prefix: number]> = [
  [ipv4ToInt(10, 0, 0, 0), 8],
  [ipv4ToInt(172, 16, 0, 0), 12],
  [ipv4ToInt(192, 168, 0, 0), 16],
];

/**
 * Factory subnet: a private IPv4 network in canonical form (host bits zero), /16 to /28.
 * One isolated Docker network per factory, so the range must be safe to hand to Docker.
 */
export const subnetCidrSchema = z
  .string()
  .trim()
  .regex(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/, "Use IPv4 CIDR notation, e.g. 172.20.1.0/24.")
  .superRefine((value, context) => {
    const [address = "", prefixText = ""] = value.split("/");
    const octets = address.split(".").map(Number);
    const prefix = Number(prefixText);
    if (octets.some((octet) => octet > 255)) {
      context.addIssue({ code: "custom", message: "Each address part must be 0–255." });
      return;
    }
    if (prefix < 16 || prefix > 28) {
      context.addIssue({ code: "custom", message: "Prefix length must be between /16 and /28." });
      return;
    }
    const [a = 0, b = 0, c = 0, d = 0] = octets;
    const ip = ipv4ToInt(a, b, c, d);
    if ((ip & maskFor(prefix)) >>> 0 !== ip) {
      context.addIssue({ code: "custom", message: "Use the network address (host bits must be zero)." });
      return;
    }
    const isPrivate = PRIVATE_RANGES.some(
      ([network, rangePrefix]) => prefix >= rangePrefix && (ip & maskFor(rangePrefix)) >>> 0 === network,
    );
    if (!isPrivate) {
      context.addIssue({ code: "custom", message: "Use a private range (10/8, 172.16/12 or 192.168/16)." });
    }
  });

export const factoryInputSchema = z.object({
  name: trimmed(80),
  slug: slugSchema,
  description: z.string().trim().max(500).optional(),
  subnetCidr: subnetCidrSchema,
});
export type FactoryInput = z.infer<typeof factoryInputSchema>;

/** The slug is fixed at creation; name, description and subnet can change later. */
export const factoryUpdateSchema = factoryInputSchema.omit({ slug: true });
export type FactoryUpdate = z.infer<typeof factoryUpdateSchema>;

/** Human-readable instance names such as VFD-01, PT-101, S7-1200-1214C-01. */
export const deviceNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Use letters, digits, dots, hyphens and underscores.");

export const deviceInstanceInputSchema = z.object({
  factoryId: z.uuid(),
  deviceModelId: z.uuid(),
  name: deviceNameSchema,
  role: z.string().trim().max(120).optional(),
  location: z.string().trim().max(120).optional(),
});
export type DeviceInstanceInput = z.infer<typeof deviceInstanceInputSchema>;

const endpointSchema = z.object({
  deviceId: z.uuid(),
  endpointType: z.enum(ENDPOINT_TYPES).default("DEVICE"),
  /** Id of the referenced endpoint row. Omitted for DEVICE endpoints. */
  endpointRef: z.uuid().optional(),
});

export const connectionInputSchema = z
  .object({
    factoryId: z.uuid(),
    relationship: z.enum(CONNECTION_RELATIONSHIPS),
    source: endpointSchema,
    target: endpointSchema,
  })
  .superRefine((value, context) => {
    for (const side of ["source", "target"] as const) {
      const endpoint = value[side];
      if (endpoint.endpointType !== "DEVICE" && !endpoint.endpointRef) {
        context.addIssue({
          code: "custom",
          path: [side, "endpointRef"],
          message: `A ${endpoint.endpointType} endpoint needs its reference id.`,
        });
      }
    }
  });
export type ConnectionInput = z.infer<typeof connectionInputSchema>;

/** Symbolic tag names are IEC identifiers, so they can be used as variable names in a program. */
export const tagNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "Use letters, digits and underscores, not starting with a digit.");

export const tagInputSchema = z.strictObject({
  name: tagNameSchema,
  dataType: z.enum(TAG_DATA_TYPES),
  role: z.enum(TAG_ROLES),
  /** IEC located address, e.g. %QX0.0, %IW3, %MD4. The Modbus address is derived from it. */
  logicalAddress: z.string().trim().min(3).max(16),
  scale: z
    .number()
    .finite()
    .refine((value) => value !== 0, "Scale must not be zero.")
    .default(1),
  offset: z.number().finite().default(0),
  unit: z.string().trim().max(16).optional(),
  /** Device instance of the same factory the value belongs to. */
  sourceDeviceInstanceId: z.uuid().optional(),
  /** Signal of that device the tag carries to or from the device simulator, e.g. `run`. */
  sourceSignal: z
    .string()
    .trim()
    .regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/, "Use a signal key such as run or actualFrequency.")
    .optional(),
});

/** A fault code of a simulated device, e.g. OVERCURRENT. */
export const faultCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/, "Use a fault code such as OVERCURRENT.");

/** A forced simulated value: a number for a sensor, true/false for a switch, null to release it. */
export const forcedValueSchema = z.union([z.number().finite(), z.boolean(), z.null()]);
export type TagInput = z.infer<typeof tagInputSchema>;

const hostPort = z.number().int().min(1).max(65535);
const ipv4 = z.string().regex(/^\d{1,3}(\.\d{1,3}){3}$/, "Use an IPv4 address.");

export const modbusEndpointInputSchema = z.strictObject({
  bindAddress: ipv4,
  hostPort,
});
export type ModbusEndpointInput = z.infer<typeof modbusEndpointInputSchema>;

/** Creating a PLC instance from a catalog model. Its process role is separate from its name. */
export const plcInputSchema = z.strictObject({
  factoryId: z.uuid(),
  deviceModelId: z.uuid(),
  name: deviceNameSchema,
  role: z.string().trim().max(120).optional(),
});
export type PlcInput = z.infer<typeof plcInputSchema>;

export const moduleInstallInputSchema = z.strictObject({
  moduleModelId: z.uuid(),
  /** Slot number on the rack, starting at 1. */
  slotIndex: z.number().int().min(1).max(64),
});

/** Adding a peripheral to a PLC: the device instance, and optionally which channel each terminal takes. */
export const peripheralInputSchema = z.strictObject({
  deviceModelId: z.uuid(),
  name: deviceNameSchema,
  role: z.string().trim().max(120).optional(),
  /** Terminal id → I/O point id. Terminals left out get the first free compatible channel. */
  assignments: z.record(z.uuid(), z.uuid()).default({}),
});
export type PeripheralInput = z.infer<typeof peripheralInputSchema>;

const canvasCoordinate = z.number().finite().min(-100_000).max(100_000);

/** Placing a catalog model on the designer canvas as a new device instance. */
export const placeDeviceInputSchema = z.strictObject({
  deviceModelId: z.uuid(),
  x: canvasCoordinate,
  y: canvasCoordinate,
  /** Left out, a free numbered name is used. */
  name: deviceNameSchema.optional(),
});

export const nodePositionsInputSchema = z
  .array(z.strictObject({ deviceId: z.uuid(), x: canvasCoordinate, y: canvasCoordinate }))
  .min(1)
  .max(500);

export const renameDeviceInputSchema = z.strictObject({
  name: deviceNameSchema,
  role: z.string().trim().max(120).optional(),
});

export const linkInputSchema = z.strictObject({
  fromId: z.uuid(),
  toId: z.uuid(),
  /** Needed only when more than one relationship is possible between the two devices. */
  kind: z.enum(["WIRE_IO", "COMMUNICATES_WITH", "DRIVES", "MECHANICALLY_DRIVES", "MEASURES", "CONTROLS"]).optional(),
});

export const unlinkInputSchema = z.strictObject({
  sourceId: z.uuid(),
  targetId: z.uuid(),
  relationship: z.enum(CONNECTION_RELATIONSHIPS),
});
