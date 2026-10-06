/**
 * The edge deployment of one PLC (TASK-503, docs/thin-client-agent.md): the desired state
 * the Z-Factory Thin Client Agent runs from. Z-Factory exports one file per PLC; the agent
 * validates it, promotes it and runs one worker for it. No database is involved at the
 * edge, so the file carries everything the agent needs and nothing it must not have:
 * no credentials, and no address the cloud may write except command and setpoint tags.
 *
 * Integrity: `checksum` is `sha256:` + the hex SHA-256 of the compact JSON text of
 * `deployment` (JSON.stringify without whitespace). The agent recomputes it from the
 * file's `deployment` value with whitespace outside strings removed, so a pretty-printed
 * file verifies as long as nothing inside it changed. Pure types; importable anywhere.
 */

export const EDGE_DEPLOYMENT_SCHEMA = "zfactory.edge-deployment";
export const EDGE_DEPLOYMENT_SCHEMA_VERSION = 1;

/** What the agent may do with a mapping: read it, or also write it on a cloud command. */
export type EdgeMappingAccess = "READ" | "WRITE";

export type EdgeMapping = {
  /** Stable id of the tag; telemetry and commands name it. */
  id: string;
  name: string;
  access: EdgeMappingAccess;
  role: string;
  /** Who drives the tag in the PLC (ADR-0015): only EXTERNAL_COMMAND is ever WRITE. */
  authority: string;
  dataType: "BOOL" | "INT16" | "UINT16" | "INT32" | "UINT32" | "FLOAT32";
  area: "COIL" | "DISCRETE_INPUT" | "HOLDING_REGISTER" | "INPUT_REGISTER";
  /** Zero-based address within the area. */
  address: number;
  wordCount: number;
  byteOrder: "BIG_ENDIAN" | "LITTLE_ENDIAN";
  wordOrder: "HIGH_WORD_FIRST" | "LOW_WORD_FIRST";
  scale: number;
  offset: number;
  unit: string | null;
  /** The engineering values a write may carry; WRITE mappings only. */
  min?: number;
  max?: number;
  /** The IEC address in the PLC program, for people reading the file. */
  programAddress: string | null;
};

export type EdgeDeploymentBody = {
  site: { factoryId: string; factoryName: string; factorySlug: string };
  plc: { plcId: string; name: string; role: string | null };
  connection: {
    protocol: "MODBUS_TCP";
    host: string;
    port: number;
    unitId: number;
    timeoutMs: number;
    pollIntervalMs: number;
  };
  /** Process modules whose signals this PLC carries: the PLC's share of the plant. */
  modules: Array<{ moduleId: string; name: string; type: string }>;
  mappings: EdgeMapping[];
};

export type EdgeDeploymentDocument = {
  schema: typeof EDGE_DEPLOYMENT_SCHEMA;
  schemaVersion: typeof EDGE_DEPLOYMENT_SCHEMA_VERSION;
  /** Grows whenever what the agent runs changes; an older version never replaces a newer one. */
  configVersion: number;
  plcId: string;
  generatedAt: string;
  checksum: string;
  deployment: EdgeDeploymentBody;
};

/** The agent's limits on a deployment, repeated here so the export never produces a file it refuses. */
export const EDGE_LIMITS = {
  pollIntervalMs: { min: 100, max: 3_600_000, default: 1000 },
  timeoutMs: { min: 100, max: 60_000, default: 2000 },
  mappings: 5000,
} as const;

/** The file name the agent's staging directory expects: one file per PLC. */
export function edgeDeploymentFileName(plcName: string): string {
  return `plc-${plcName.toLowerCase().replace(/[^a-z0-9._-]+/g, "-")}.json`;
}
