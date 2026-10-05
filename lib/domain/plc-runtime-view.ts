/**
 * Shapes the Program, Versions and Runtime screens of a stored PLC render
 * (docs/design.md → PLC edit). Pure types; importable anywhere.
 *
 * Nothing here carries a Docker identifier or the runtime's management port: the screens
 * know a PLC runtime by its Z-Factory device id and its service name only.
 */
import type { RuntimeState } from "@/lib/domain/runtime-state";

/** Lifecycle of a program version (docs/openplc-runtime.md → What is recorded). */
export const PROGRAM_VERSION_STATUSES = ["DRAFT", "COMPILED", "DEPLOYED", "FAILED", "ARCHIVED"] as const;

export type ProgramVersionStatus = (typeof PROGRAM_VERSION_STATUSES)[number];

export type ProgramVersionView = {
  id: string;
  version: number;
  status: ProgramVersionStatus;
  /** SHA-256 of the source. */
  checksum: string;
  createdAt: string;
  /** The version the next start or deploy uses. */
  selected: boolean;
};

/** A tag of the PLC as a located variable a program can declare. */
export type LocatedVariableView = {
  name: string;
  address: string;
  /** IEC 61131-3 elementary type, e.g. `BOOL`, `INT`, `REAL`. */
  type: string;
  /** Device signal the simulator wires to the tag, e.g. `VFD-01 · run`. */
  source: string | null;
};

export type PlcProgramView = {
  versions: ProgramVersionView[];
  /** What the editor opens with: a stored version, or a starter program when there is none. */
  source: string;
  /** Version the source belongs to; null for the starter program. */
  sourceVersion: number | null;
  locatedVariables: LocatedVariableView[];
  maxSourceBytes: number;
};

/** The configuration recorded when a program version was deployed. */
export type DeploymentView = {
  version: number;
  createdAt: string;
  programVersion: number | null;
  programChecksum: string | null;
  compiler: string | null;
  ioMappingVersion: number | null;
  modbusMappingVersion: number | null;
  runtime: string | null;
  tagCount: number | null;
};

export type PlcVersionsView = {
  /** Newest first. */
  versions: ProgramVersionView[];
  /** Newest first. */
  deployments: DeploymentView[];
  runtimeCreated: boolean;
};

export type RuntimeEventView = {
  id: string;
  type: string;
  severity: "INFO" | "WARNING" | "CRITICAL";
  occurredAt: string;
  detail: string;
};

export type PlcRuntimeView = {
  state: RuntimeState;
  /** Whether the PLC has a runtime container at the moment. */
  created: boolean;
  /** DNS name of the PLC inside its factory network. */
  serviceName: string | null;
  runtimeVersion: string | null;
  image: string | null;
  /** Host endpoint of the PLC's Modbus TCP server. */
  modbus: { bindAddress: string; hostPort: number } | null;
  selectedProgram: { version: number; status: ProgramVersionStatus } | null;
  deployedProgram: { version: number } | null;
  /** Newest first. */
  events: RuntimeEventView[];
  /** Why the live state could not be read; the stored state is shown instead. */
  liveError: string | null;
};

/** Payload keys of runtime events that are safe and useful to show, in display order. */
const EVENT_DETAIL_KEYS = ["action", "version", "state", "plcStatus", "code", "rule", "warnings"] as const;

/** `{ action: "start", code: "RUNTIME_FAILURE" }` → `action start · code RUNTIME_FAILURE`. */
export function eventDetail(payload: unknown): string {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return "";
  const record = payload as Record<string, unknown>;
  return EVENT_DETAIL_KEYS.flatMap((key) => {
    const value = record[key];
    return typeof value === "string" || typeof value === "number" ? [`${key} ${value}`] : [];
  }).join(" · ");
}
