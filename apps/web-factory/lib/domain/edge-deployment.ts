import { z } from "zod";

/**
 * The edge deployment of one PLC (`zfactory.edge-deployment` version 1), as Z-Factory
 * exports it and the Thin Client Agent runs it (docs/thin-client-agent.md). Web Factory
 * imports no Z-Factory code: this is its own copy of the contract, checked strictly.
 *
 * Web Factory registers a PLC from the same file the agent got, so the cloud knows the
 * PLC's identity, its tags and which of them a command may write, without ever reaching
 * the PLC. Pure; importable anywhere.
 */

export const EDGE_DEPLOYMENT_SCHEMA = "zfactory.edge-deployment";
export const EDGE_DEPLOYMENT_SCHEMA_VERSION = 1;

const id = z.string().min(1).max(64);
const name = z.string().min(1).max(200);

const mappingSchema = z.strictObject({
  id,
  name,
  access: z.enum(["READ", "WRITE"]),
  role: z.string().min(1).max(40),
  authority: z.string().min(1).max(40),
  dataType: z.enum(["BOOL", "INT16", "UINT16", "INT32", "UINT32", "FLOAT32"]),
  area: z.enum(["COIL", "DISCRETE_INPUT", "HOLDING_REGISTER", "INPUT_REGISTER"]),
  address: z.number().int().min(0).max(65535),
  wordCount: z.number().int().min(1).max(2),
  byteOrder: z.enum(["BIG_ENDIAN", "LITTLE_ENDIAN"]),
  wordOrder: z.enum(["HIGH_WORD_FIRST", "LOW_WORD_FIRST"]),
  scale: z.number().finite(),
  offset: z.number().finite(),
  unit: z.string().max(40).nullable(),
  min: z.number().finite().optional(),
  max: z.number().finite().optional(),
  programAddress: z.string().max(40).nullable(),
});

export const deploymentBodySchema = z.strictObject({
  site: z.strictObject({ factoryId: id, factoryName: name, factorySlug: z.string().min(1).max(120) }),
  plc: z.strictObject({ plcId: id, name, role: z.string().max(120).nullable() }),
  connection: z.strictObject({
    protocol: z.literal("MODBUS_TCP"),
    host: z.string().min(1).max(253),
    port: z.number().int().min(1).max(65535),
    unitId: z.number().int().min(0).max(255),
    timeoutMs: z.number().int().positive(),
    pollIntervalMs: z.number().int().positive(),
  }),
  modules: z.array(z.strictObject({ moduleId: id, name, type: z.string().min(1).max(80) })).max(500),
  mappings: z.array(mappingSchema).max(5000),
});

export const deploymentDocumentSchema = z.strictObject({
  schema: z.literal(EDGE_DEPLOYMENT_SCHEMA),
  schemaVersion: z.literal(EDGE_DEPLOYMENT_SCHEMA_VERSION),
  configVersion: z.number().int().min(1).max(2_147_483_647),
  plcId: id,
  generatedAt: z.string().max(40),
  checksum: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  deployment: deploymentBodySchema,
});

export type EdgeDeploymentBody = z.infer<typeof deploymentBodySchema>;
export type EdgeDeploymentDocument = z.infer<typeof deploymentDocumentSchema>;
export type EdgeMapping = EdgeDeploymentBody["mappings"][number];

/** Why a deployment file cannot be registered, by rule. */
export type DeploymentProblem = { rule: string; message: string };

/**
 * The checks beyond the shape: the file names one PLC, names and ids are unique, and
 * only command and setpoint tags of external command memory are writable — the same
 * allow-list the agent enforces (ADR-0015).
 */
export function deploymentProblems(document: EdgeDeploymentDocument): DeploymentProblem[] {
  const problems: DeploymentProblem[] = [];
  const { deployment } = document;
  if (deployment.plc.plcId !== document.plcId) {
    problems.push({ rule: "plc-id", message: "The deployment names another PLC than the file." });
  }
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const mapping of deployment.mappings) {
    if (ids.has(mapping.id) || names.has(mapping.name)) {
      problems.push({ rule: "mapping-duplicate", message: `Tag ${mapping.name} appears twice.` });
    }
    ids.add(mapping.id);
    names.add(mapping.name);
    if (mapping.access === "WRITE") {
      const commandTag =
        mapping.authority === "EXTERNAL_COMMAND" &&
        (mapping.role === "COMMAND" || mapping.role === "SETPOINT") &&
        (mapping.area === "COIL" || mapping.area === "HOLDING_REGISTER");
      if (!commandTag) {
        problems.push({
          rule: "mapping-write",
          message: `${mapping.name} is writable but not a command or setpoint tag; the PLC program decides it.`,
        });
      }
    }
  }
  return problems;
}

/** The text the checksum is taken over: the compact JSON of `deployment`, as Z-Factory hashes it. */
export function checksumText(body: unknown): string {
  return JSON.stringify(body);
}
