import { z } from "zod";
import { TOPIC_SEGMENT } from "./agent-messages";

/**
 * Commands and setpoints from Web Factory to a PLC tag (TASK-905, ADR-0022). Pure;
 * importable anywhere.
 *
 * Web Factory checks a command against the PLC's registered deployment before publishing,
 * the same rules the agent checks again against the deployment it runs (ADR-0015):
 * only a tag marked WRITE with role COMMAND or SETPOINT and authority EXTERNAL_COMMAND,
 * a boolean for a BOOL tag, otherwise a finite number in the tag's range. The PLC program
 * decides what the written command or setpoint leads to.
 */

export const COMMAND_SCHEMA = "zfactory.command";
export const ACK_SCHEMA = "zfactory.command-ack";
/** The agent refuses a command that expires more than 10 minutes ahead. */
export const MAX_TTL_MS = 10 * 60_000;
export const DEFAULT_TTL_MS = 60_000;

export type CommandMapping = {
  externalId: string;
  name: string;
  access: string;
  role: string;
  authority: string;
  dataType: string;
  min: number | null;
  max: number | null;
};

export type CommandRefusal = { rule: string; reason: string };

/** Whether the tag may be written from the cloud at all. */
export function writable(mapping: Pick<CommandMapping, "access" | "role" | "authority">): boolean {
  return (
    mapping.access === "WRITE" &&
    mapping.authority === "EXTERNAL_COMMAND" &&
    (mapping.role === "COMMAND" || mapping.role === "SETPOINT")
  );
}

/** The value a command carries, checked against its tag; or why it is refused. */
export function checkValue(
  mapping: CommandMapping,
  value: unknown,
): { ok: true; value: number | boolean } | ({ ok: false } & CommandRefusal) {
  if (!writable(mapping)) {
    return {
      ok: false,
      rule: "not-writable",
      reason: `${mapping.name} is not a command or setpoint tag; the PLC program decides it.`,
    };
  }
  if (mapping.dataType === "BOOL") {
    return typeof value === "boolean"
      ? { ok: true, value }
      : { ok: false, rule: "value-type", reason: `${mapping.name} takes on or off.` };
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return { ok: false, rule: "value-type", reason: `${mapping.name} takes a number.` };
  }
  if (mapping.min === null || mapping.max === null || value < mapping.min || value > mapping.max) {
    return {
      ok: false,
      rule: "value-range",
      reason: `${mapping.name} takes ${mapping.min ?? "?"} to ${mapping.max ?? "?"}.`,
    };
  }
  return { ok: true, value };
}

/** The command message the agent reads (internal/command: strict, unknown fields refused). */
export function commandEnvelope(input: {
  commandId: string;
  plcId: string;
  mappingId: string;
  value: number | boolean;
  configVersion: number;
  issuedAt: Date;
  expiresAt: Date;
  requestedBy: string;
}) {
  return {
    schema: COMMAND_SCHEMA,
    version: 1,
    commandId: input.commandId,
    plcId: input.plcId,
    mappingId: input.mappingId,
    value: input.value,
    configVersion: input.configVersion,
    issuedAt: input.issuedAt.toISOString(),
    expiresAt: input.expiresAt.toISOString(),
    requestedBy: input.requestedBy,
  };
}

export const ACK_STATUSES = ["ACCEPTED", "REJECTED", "APPLIED", "FAILED"] as const;

export const commandAckSchema = z.object({
  schema: z.literal(ACK_SCHEMA),
  version: z.literal(1),
  commandId: z.string().min(1).max(64),
  plcId: z.string().regex(TOPIC_SEGMENT).or(z.literal("")),
  mappingId: z.string().max(64).optional(),
  status: z.enum(ACK_STATUSES),
  rule: z.string().max(80).optional(),
  reason: z.string().max(2000).optional(),
  observed: z.unknown().optional(),
  duplicate: z.boolean().optional(),
  at: z.coerce.date(),
});

export type CommandAck = z.infer<typeof commandAckSchema>;

export type CommandStatusName =
  "REQUESTED" | "PUBLISHED" | "ACCEPTED" | "REJECTED" | "APPLIED" | "FAILED" | "TIMED_OUT";

export const FINAL: ReadonlySet<CommandStatusName> = new Set(["REJECTED", "APPLIED", "FAILED"]);

/**
 * The status after an acknowledgement. A command never goes back: ACCEPTED only follows
 * PUBLISHED (or a REQUESTED whose publish confirmation is still on its way); a final
 * answer (REJECTED, APPLIED, FAILED) is kept once given. A final answer after a timeout is
 * taken, marked late. A redelivered acknowledgement (`duplicate`) changes nothing.
 */
export function afterAck(
  current: CommandStatusName,
  ack: Pick<CommandAck, "status" | "duplicate">,
): { status: CommandStatusName; late: boolean } | null {
  if (ack.duplicate) return null;
  if (FINAL.has(current)) return null;
  if (ack.status === "ACCEPTED") {
    return current === "PUBLISHED" || current === "REQUESTED" ? { status: "ACCEPTED", late: false } : null;
  }
  return { status: ack.status, late: current === "TIMED_OUT" };
}

/** Whether telemetry shows the commanded value (floats within a part in a million). */
export function sameValue(requested: number | boolean, seen: number | boolean | null): boolean {
  if (seen === null) return false;
  if (typeof requested === "boolean" || typeof seen === "boolean") return requested === seen;
  return Math.abs(requested - seen) <= Math.max(1e-9, Math.abs(requested) * 1e-6);
}
