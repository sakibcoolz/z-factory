import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { Actor } from "@/lib/auth/actor";
import { factoryRepository } from "@/lib/db/repositories/factory-repository";
import { plcCommunicationRepository } from "@/lib/db/repositories/plc-communication-repository";
import { processModuleRepository } from "@/lib/db/repositories/process-module-repository";
import { tagRepository } from "@/lib/db/repositories/tag-repository";
import {
  EDGE_DEPLOYMENT_SCHEMA,
  EDGE_DEPLOYMENT_SCHEMA_VERSION,
  EDGE_LIMITS,
  type EdgeDeploymentBody,
  type EdgeDeploymentDocument,
  type EdgeMapping,
} from "@/lib/domain/edge-deployment";
import { DomainError } from "@/lib/domain/errors";
import { tagAuthority } from "@/lib/domain/tag-authority";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { engineeringRange } from "@/lib/protocols/modbus/codec";
import { publishedModbusEndpoint } from "@/lib/runtimes/openplc/adapter";
import { parseInput } from "@/lib/validation/parse";
import { loadPlc } from "./plc-runtime-service";

/**
 * Exports the edge deployment of one PLC for the Z-Factory Thin Client Agent (TASK-503,
 * docs/thin-client-agent.md). Every mapped tag of the PLC is in it for reading; only
 * external command memory (command and setpoint tags, ADR-0015) is marked WRITE, so the
 * cloud can never reach a program output, an input or feedback through the agent.
 */

const optionsSchema = z.strictObject({
  /** Where the agent reaches the PLC; defaults to the PLC runtime's published endpoint. */
  host: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(/^[A-Za-z0-9.:-]+$/, "a host name or IP address")
    .optional(),
  port: z.number().int().min(1).max(65_535).optional(),
  unitId: z.number().int().min(0).max(255).default(1),
  pollIntervalMs: z
    .number()
    .int()
    .min(EDGE_LIMITS.pollIntervalMs.min)
    .max(EDGE_LIMITS.pollIntervalMs.max)
    .default(EDGE_LIMITS.pollIntervalMs.default),
  timeoutMs: z
    .number()
    .int()
    .min(EDGE_LIMITS.timeoutMs.min)
    .max(EDGE_LIMITS.timeoutMs.max)
    .default(EDGE_LIMITS.timeoutMs.default),
});

export type EdgeDeploymentOptions = z.input<typeof optionsSchema>;

/** `sha256:` + hex digest of the compact JSON text of the deployment body. */
export function edgeChecksum(body: EdgeDeploymentBody): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(body)).digest("hex")}`;
}

export async function exportEdgeDeployment(
  db: PrismaClient,
  actor: Actor,
  plcId: string,
  input: EdgeDeploymentOptions = {},
  now: () => Date = () => new Date(),
): Promise<EdgeDeploymentDocument> {
  const options = parseInput(optionsSchema, input);
  const { device, profile } = await loadPlc(db, actor, plcId);
  const factory = await factoryRepository.findById(db, actor.ownerId, device.factoryId);
  if (!factory) throw new DomainError("NOT_FOUND", "The factory does not exist.");

  const port = device.runtimePorts.find((candidate) => candidate.protocol === "MODBUS_TCP" && candidate.hostPort);
  const published = port?.hostPort ? publishedModbusEndpoint(port.bindAddress, port.hostPort) : null;
  const host = options.host ?? published?.host;
  const modbusPort = options.port ?? published?.port;
  if (!host || !modbusPort) {
    throw new DomainError(
      "CONFLICT",
      `${device.name} has no Modbus endpoint yet. Start its runtime once, or give the host and port the agent reaches it at.`,
      { rule: "edge-endpoint-required" },
    );
  }

  const linkInputs = await plcCommunicationRepository.linkInputTagIds(db, [device.id]);
  const mappings = (await tagRepository.listByPlc(db, device.id))
    .filter((tag) => tag.protocolArea !== null && tag.protocolAddress !== null)
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((tag): EdgeMapping => {
      const authority = tagAuthority({ ...tag, linkInput: linkInputs.has(tag.id) });
      const writable = authority === "EXTERNAL_COMMAND";
      const encoding = {
        dataType: tag.dataType,
        byteOrder: tag.byteOrder,
        wordOrder: tag.wordOrder,
        scale: tag.scale,
        offset: tag.offset,
      };
      const [min, max] = engineeringRange(encoding);
      return {
        id: tag.id,
        name: tag.name,
        access: writable ? "WRITE" : "READ",
        role: tag.role,
        authority,
        dataType: tag.dataType,
        area: tag.protocolArea!,
        address: tag.protocolAddress!,
        wordCount: tag.wordCount,
        byteOrder: tag.byteOrder,
        wordOrder: tag.wordOrder,
        scale: tag.scale,
        offset: tag.offset,
        unit: tag.unit,
        ...(writable ? { min, max } : {}),
        programAddress: tag.logicalAddress,
      };
    });
  if (mappings.length > EDGE_LIMITS.mappings) {
    throw new DomainError("VALIDATION", `An edge deployment carries at most ${EDGE_LIMITS.mappings} tags.`, {
      rule: "edge-mapping-count",
    });
  }

  const modules = new Map<string, { moduleId: string; name: string; type: string }>();
  for (const binding of await processModuleRepository.listPlcModules(db, device.id)) {
    modules.set(binding.processModuleInstanceId, {
      moduleId: binding.processModuleInstanceId,
      name: binding.processModuleInstance.name,
      type: binding.processModuleInstance.processModuleType.code,
    });
  }

  const deployment: EdgeDeploymentBody = {
    site: { factoryId: factory.id, factoryName: factory.name, factorySlug: factory.slug },
    plc: { plcId: device.id, name: device.name, role: device.role ?? null },
    connection: {
      protocol: "MODBUS_TCP",
      host,
      port: modbusPort,
      unitId: options.unitId,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
    },
    modules: [...modules.values()].sort((a, b) => a.name.localeCompare(b.name)),
    mappings,
  };
  return {
    schema: EDGE_DEPLOYMENT_SCHEMA,
    schemaVersion: EDGE_DEPLOYMENT_SCHEMA_VERSION,
    // The tag mapping version grows with every tag change: what the agent reads and writes.
    configVersion: profile.modbusMappingVersion,
    plcId: device.id,
    generatedAt: now().toISOString(),
    checksum: edgeChecksum(deployment),
    deployment,
  };
}
