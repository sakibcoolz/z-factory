/** Input shapes of the PLC-to-PLC link service (TASK-701). The service checks the invariants. */
import { z } from "zod";
import {
  PLC_LINK_CLIENTS,
  PLC_LINK_LIMITS,
  PLC_LINK_PROTOCOLS,
  PLC_RELATIONSHIPS,
} from "@/lib/domain/plc-communication";

const bounded = (limit: { min: number; max: number }) => z.number().int().min(limit.min).max(limit.max);

export const plcLinkInputSchema = z.strictObject({
  factoryId: z.uuid(),
  sourcePlcId: z.uuid(),
  targetPlcId: z.uuid(),
  relationship: z.enum(PLC_RELATIONSHIPS),
  protocol: z.enum(PLC_LINK_PROTOCOLS).default("MODBUS_TCP"),
  /** Which end is the protocol client; the source by default. */
  client: z.enum(PLC_LINK_CLIENTS).default("SOURCE"),
  serverPort: bounded(PLC_LINK_LIMITS.serverPort).optional(),
  unitId: bounded(PLC_LINK_LIMITS.unitId).optional(),
  pollIntervalMs: bounded(PLC_LINK_LIMITS.pollIntervalMs).optional(),
  enabled: z.boolean().optional(),
});

export type PlcLinkInput = z.infer<typeof plcLinkInputSchema>;

export const plcLinkUpdateSchema = z.strictObject({
  relationship: z.enum(PLC_RELATIONSHIPS).optional(),
  client: z.enum(PLC_LINK_CLIENTS).optional(),
  serverPort: bounded(PLC_LINK_LIMITS.serverPort).optional(),
  unitId: bounded(PLC_LINK_LIMITS.unitId).optional(),
  pollIntervalMs: bounded(PLC_LINK_LIMITS.pollIntervalMs).optional(),
  enabled: z.boolean().optional(),
});

export type PlcLinkUpdate = z.infer<typeof plcLinkUpdateSchema>;
