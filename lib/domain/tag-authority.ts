/**
 * Who drives a tag (ADR-0015, docs/openplc-runtime.md → PLC scan-cycle and physical I/O
 * authority). Every tag of a PLC is owned by exactly one of these; the owner is the only
 * thing that writes it, everything else reads. Pure rules; importable anywhere.
 *
 *   PROGRAM_OUTPUT       a local output of the PLC (%Q), or memory through which the program
 *                        commands simulated equipment (a device's command signal, a process
 *                        module's OUTPUT): the scan cycle writes it; the simulators, telemetry
 *                        and gateways only observe it (TASK-803)
 *   PROGRAM_INPUT        a local input: an input point (the %M shadow of a DI/AI channel) or
 *                        a %I address; the field, or the simulation bridge, writes it
 *   SIMULATION_FEEDBACK  memory a simulation bridge fills with what a device or process
 *                        produces; the program reads it
 *   LINK_INPUT           %I or %M a PLC link (Phase 07) fills with a peer PLC's value; the
 *                        program reads it
 *   EXTERNAL_COMMAND     command/setpoint memory a gateway or the UI may write; the program
 *                        decides what to do with it
 *   PROGRAM_INTERNAL     everything else: memory the program keeps for itself and others read
 */
import { deviceSignalDirection } from "@/lib/domain/simulation";
import type { AccessMode, TagRole } from "@/lib/domain/tag";
import { isWritableTagRole } from "@/lib/domain/tag";

export const TAG_AUTHORITIES = [
  "PROGRAM_OUTPUT",
  "PROGRAM_INPUT",
  "SIMULATION_FEEDBACK",
  "LINK_INPUT",
  "EXTERNAL_COMMAND",
  "PROGRAM_INTERNAL",
] as const;

export type TagAuthority = (typeof TAG_AUTHORITIES)[number];

export const TAG_AUTHORITY_LABELS: Record<TagAuthority, string> = {
  PROGRAM_OUTPUT: "program output",
  PROGRAM_INPUT: "field input",
  SIMULATION_FEEDBACK: "simulated feedback",
  LINK_INPUT: "PLC link input",
  EXTERNAL_COMMAND: "external command",
  PROGRAM_INTERNAL: "program memory",
};

export type AuthorityTag = {
  role: TagRole;
  accessMode: AccessMode;
  logicalAddress: string | null;
  /** The PLC I/O point the tag sits on, when it is a channel rather than memory. */
  plcIoPointId: string | null;
  /** The device signal the tag carries to or from the device simulator. */
  sourceSignal: string | null;
  /** The process-module signal the tag carries, when a module is bound to it. */
  moduleSignalDirection?: "INPUT" | "OUTPUT" | "INTERNAL" | "ALARM" | null;
  /** The tag is filled by a READ mapping of a PLC link (TASK-702). */
  linkInput?: boolean;
};

const region = (logicalAddress: string | null) => /^%([IQM])/i.exec(logicalAddress ?? "")?.[1]?.toUpperCase();

/** Which part of the control loop owns a tag. */
export function tagAuthority(tag: AuthorityTag): TagAuthority {
  const where = region(tag.logicalAddress);
  if (tag.plcIoPointId) return where === "Q" ? "PROGRAM_OUTPUT" : "PROGRAM_INPUT";
  if (tag.accessMode === "READ_WRITE" && isWritableTagRole(tag.role)) return "EXTERNAL_COMMAND";
  if (where === "Q") return "PROGRAM_OUTPUT";
  if (tag.linkInput) return "LINK_INPUT";
  if (where === "I") return "PROGRAM_INPUT";
  // A command the program gives simulated equipment is the program's, wherever it sits.
  if (
    (tag.sourceSignal && deviceSignalDirection(tag.sourceSignal) === "IN") ||
    tag.moduleSignalDirection === "OUTPUT"
  ) {
    return "PROGRAM_OUTPUT";
  }
  if (tag.sourceSignal || tag.moduleSignalDirection === "INPUT" || tag.moduleSignalDirection === "ALARM") {
    return "SIMULATION_FEEDBACK";
  }
  return "PROGRAM_INTERNAL";
}

/**
 * Whether a normal control write (UI, gateway) may reach the tag: only external command
 * memory. A program output is never written from outside, however it is addressed.
 */
export function isExternallyWritable(tag: AuthorityTag): boolean {
  return tagAuthority(tag) === "EXTERNAL_COMMAND";
}
