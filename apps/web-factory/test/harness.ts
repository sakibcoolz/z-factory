import { createHash } from "node:crypto";
import "dotenv/config";
import { createPrismaClient } from "@/lib/db/client";
import type { PrismaClient } from "@/lib/generated/prisma/client";

/** Integration tests run against WEB_FACTORY_TEST_DATABASE_URL, never the development database. */
export const withDb = Boolean(process.env.WEB_FACTORY_TEST_DATABASE_URL);

export function openTestDb(): PrismaClient {
  return createPrismaClient(process.env.WEB_FACTORY_TEST_DATABASE_URL ?? "");
}

export async function resetDb(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    'TRUNCATE telemetry.batch, telemetry.sample, "Alarm", "PlcEvent", "TagLatest", "AgentConnectionEvent", "AuditEvent", "PlcModule", "Module", "PlcMapping", "Plc", "Factory", "EdgeAgent", "Site", "Membership", "User", "Organization" CASCADE',
  );
}

type Mapping = Record<string, unknown>;

/** A deployment file as Z-Factory exports it: checksum over the compact JSON of `deployment`. */
export function deploymentFile(
  options: {
    plcId?: string;
    plcName?: string;
    factoryId?: string;
    version?: number;
    mappings?: Mapping[];
    modules?: Array<{ moduleId: string; name: string; type: string }>;
    pretty?: boolean;
    host?: string;
    port?: number;
    pollIntervalMs?: number;
  } = {},
): string {
  const plcId = options.plcId ?? "plc-1";
  const deployment = {
    site: { factoryId: options.factoryId ?? "factory-1", factoryName: "Pump House", factorySlug: "pump-house" },
    plc: { plcId, name: options.plcName ?? "PLC-01", role: null },
    connection: {
      protocol: "MODBUS_TCP",
      host: options.host ?? "10.0.0.15",
      port: options.port ?? 502,
      unitId: 1,
      timeoutMs: 2000,
      pollIntervalMs: options.pollIntervalMs ?? 1000,
    },
    modules: options.modules ?? [{ moduleId: "module-1", name: "PH-01", type: "PUMP_HOUSE" }],
    mappings: options.mappings ?? [
      mapping("t-start", "Start_Cmd", "WRITE", "COMMAND", "EXTERNAL_COMMAND", "BOOL", "COIL", 800),
      {
        ...mapping("t-speed", "Speed_SP", "WRITE", "SETPOINT", "EXTERNAL_COMMAND", "INT16", "HOLDING_REGISTER", 101),
        scale: 0.1,
        unit: "Hz",
        min: -3276.8,
        max: 3276.7,
      },
      mapping("t-running", "Running", "READ", "STATUS", "PROGRAM_OUTPUT", "BOOL", "COIL", 8192),
    ],
  };
  const checksum = `sha256:${createHash("sha256").update(JSON.stringify(deployment)).digest("hex")}`;
  const document = {
    schema: "zfactory.edge-deployment",
    schemaVersion: 1,
    configVersion: options.version ?? 1,
    plcId,
    generatedAt: "2026-10-07T00:00:00.000Z",
    checksum,
    deployment,
  };
  return options.pretty === false ? JSON.stringify(document) : `${JSON.stringify(document, null, 2)}\n`;
}

export function mapping(
  id: string,
  name: string,
  access: string,
  role: string,
  authority: string,
  dataType: string,
  area: string,
  address: number,
): Mapping {
  return {
    id,
    name,
    access,
    role,
    authority,
    dataType,
    area,
    address,
    wordCount: dataType === "INT32" || dataType === "UINT32" || dataType === "FLOAT32" ? 2 : 1,
    byteOrder: "BIG_ENDIAN",
    wordOrder: "HIGH_WORD_FIRST",
    scale: 1,
    offset: 0,
    unit: null,
    programAddress: null,
  };
}
