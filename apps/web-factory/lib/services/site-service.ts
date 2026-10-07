import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import {
  checksumText,
  deploymentDocumentSchema,
  deploymentProblems,
  type EdgeDeploymentDocument,
} from "@/lib/domain/edge-deployment";
import { DomainError } from "@/lib/domain/errors";
import type { Prisma, PrismaClient } from "@/lib/generated/prisma/client";
import { audit } from "./audit-service";

/**
 * Sites, their Thin Client Agents and the PLCs the agents run (TASK-901). Nothing here
 * talks to a PLC or to MQTT: a PLC is registered from the same deployment file its agent
 * runs, which gives the cloud its identity, its tags and its writable allow-list.
 */

const notFound = (what: string) => new DomainError("NOT_FOUND", `The ${what} does not exist.`);

/** An MQTT topic segment: zfactory/{siteKey}/{agentKey}/… (the agent refuses anything else). */
const topicKey = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9_-]{1,64}$/, "Use 1-64 letters, digits, _ and -; it is part of the MQTT topics.");
const displayName = z.string().trim().min(1, "Enter a name.").max(120);

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    const issue = result.error.issues[0];
    throw new DomainError("VALIDATION", issue?.message ?? "Invalid input.", { field: issue?.path.join(".") });
  }
  return result.data;
}

export async function listSites(db: Db, actor: Actor, organizationId: string) {
  const { organization, role } = await requireMembership(db, actor, organizationId, "view");
  const sites = await db.site.findMany({
    where: { organizationId },
    orderBy: { name: "asc" },
    include: {
      agents: { orderBy: { name: "asc" }, include: { _count: { select: { plcs: true } } } },
      _count: { select: { factories: true } },
    },
  });
  return { organization, role, sites };
}

export async function createSite(db: PrismaClient, actor: Actor, organizationId: string, input: unknown) {
  await requireMembership(db, actor, organizationId, "manageSites");
  const data = parse(z.strictObject({ siteKey: topicKey, name: displayName }), input);
  if (await db.site.findUnique({ where: { siteKey: data.siteKey } })) {
    // Site keys are unique on the broker, so across organizations too; say so without telling whose.
    throw new DomainError("CONFLICT", `The site id ${data.siteKey} is taken.`, { rule: "site-key", field: "siteKey" });
  }
  const site = await db.site.create({ data: { organizationId, ...data } });
  await audit(db, {
    organizationId,
    actorUserId: actor.userId,
    action: "SITE_CREATED",
    subjectType: "SITE",
    subjectId: site.id,
    detail: data,
  });
  return site;
}

async function siteOf(db: Db, actor: Actor, siteId: string, permission: "view" | "manageSites") {
  const site = isUuid(siteId) ? await db.site.findUnique({ where: { id: siteId } }) : null;
  if (!site) throw notFound("site");
  // A site of another organization does not exist for the actor.
  const access = await requireMembership(db, actor, site.organizationId, permission).catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("site");
    throw error;
  });
  return { site, ...access };
}

export async function getSite(db: Db, actor: Actor, siteId: string) {
  const { site, organization, role } = await siteOf(db, actor, siteId, "view");
  const agents = await db.edgeAgent.findMany({
    where: { siteId: site.id },
    orderBy: { name: "asc" },
    include: { plcs: { orderBy: { name: "asc" }, select: { id: true, name: true, configVersion: true } } },
  });
  return { site, organization, role, agents };
}

export async function createAgent(db: PrismaClient, actor: Actor, siteId: string, input: unknown) {
  const { site } = await siteOf(db, actor, siteId, "manageSites");
  const data = parse(z.strictObject({ agentKey: topicKey, name: displayName }), input);
  if (await db.edgeAgent.findUnique({ where: { siteId_agentKey: { siteId: site.id, agentKey: data.agentKey } } })) {
    throw new DomainError("CONFLICT", `This site has an agent ${data.agentKey} already.`, {
      rule: "agent-key",
      field: "agentKey",
    });
  }
  const agent = await db.edgeAgent.create({ data: { siteId: site.id, ...data } });
  await audit(db, {
    organizationId: site.organizationId,
    actorUserId: actor.userId,
    action: "AGENT_REGISTERED",
    subjectType: "AGENT",
    subjectId: agent.id,
    detail: { siteKey: site.siteKey, ...data },
  });
  return agent;
}

async function agentOf(db: Db, actor: Actor, agentId: string, permission: "view" | "manageSites") {
  const agent = isUuid(agentId)
    ? await db.edgeAgent.findUnique({ where: { id: agentId }, include: { site: true } })
    : null;
  if (!agent) throw notFound("agent");
  const access = await requireMembership(db, actor, agent.site.organizationId, permission).catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("agent");
    throw error;
  });
  return { agent, ...access };
}

export async function getAgent(db: Db, actor: Actor, agentId: string) {
  const { agent, organization, role } = await agentOf(db, actor, agentId, "view");
  const plcs = await db.plc.findMany({
    where: { edgeAgentId: agent.id },
    orderBy: { name: "asc" },
    include: {
      factory: true,
      _count: { select: { mappings: true } },
      mappings: { where: { access: "WRITE" }, select: { id: true } },
    },
  });
  return {
    agent,
    organization,
    role,
    topicRoot: `zfactory/${agent.site.siteKey}/${agent.agentKey}`,
    plcs: plcs.map((plc) => ({
      id: plc.id,
      externalPlcId: plc.externalPlcId,
      name: plc.name,
      factory: plc.factory.name,
      configVersion: plc.configVersion,
      mappings: plc._count.mappings,
      writable: plc.mappings.length,
      updatedAt: plc.updatedAt,
    })),
  };
}

export async function getPlc(db: Db, actor: Actor, plcId: string) {
  const plc = isUuid(plcId)
    ? await db.plc.findUnique({
        where: { id: plcId },
        include: {
          agent: { include: { site: true } },
          factory: true,
          mappings: { orderBy: { name: "asc" } },
          modules: { include: { module: true } },
        },
      })
    : null;
  if (!plc) throw notFound("PLC");
  const access = await requireMembership(db, actor, plc.agent.site.organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound("PLC");
    throw error;
  });
  const document = plc.deploymentJson as unknown as EdgeDeploymentDocument;
  return { plc, ...access, connection: document.deployment.connection };
}

/** Reads, checks and verifies a deployment file. */
export function readDeployment(text: string): EdgeDeploymentDocument {
  if (text.length > 8 * 1024 * 1024) {
    throw new DomainError("VALIDATION", "The file is larger than 8 MiB.", { rule: "file-size" });
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new DomainError("VALIDATION", "The file is not JSON.", { rule: "json" });
  }
  const parsed = deploymentDocumentSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new DomainError(
      "VALIDATION",
      `Not an edge deployment file: ${issue?.path.join(".") || "file"} ${issue?.message ?? ""}`.trim(),
      {
        rule: "schema",
      },
    );
  }
  // The checksum covers the deployment as exported; any edit after export fails it.
  const actual = `sha256:${createHash("sha256")
    .update(checksumText((raw as { deployment: unknown }).deployment))
    .digest("hex")}`;
  if (actual !== parsed.data.checksum) {
    throw new DomainError("VALIDATION", "The file was changed after export: its checksum does not match.", {
      rule: "checksum",
    });
  }
  const problem = deploymentProblems(parsed.data)[0];
  if (problem) throw new DomainError("VALIDATION", problem.message, { rule: problem.rule });
  return parsed.data;
}

/**
 * Registers the PLC of a deployment file under an agent, or updates it to a newer
 * configuration version. The file is the one the agent runs; Web Factory never reaches
 * the PLC. Refused: a changed file, an older version, the same version with other
 * content, a PLC that another agent of the organization runs, or a factory of another site.
 */
export async function registerDeployment(db: PrismaClient, actor: Actor, agentId: string, text: unknown) {
  const { agent } = await agentOf(db, actor, agentId, "manageSites");
  if (typeof text !== "string" || text.trim() === "") throw new DomainError("VALIDATION", "Choose a deployment file.");
  const document = readDeployment(text);
  const body = document.deployment;
  const organizationId = agent.site.organizationId;

  return db.$transaction(async (tx) => {
    const elsewhere = await tx.plc.findFirst({
      where: { externalPlcId: document.plcId, edgeAgentId: { not: agent.id }, agent: { site: { organizationId } } },
      include: { agent: true },
    });
    if (elsewhere) {
      throw new DomainError(
        "CONFLICT",
        `${body.plc.name} is run by agent ${elsewhere.agent.agentKey}; a PLC has one agent.`,
        {
          rule: "plc-elsewhere",
        },
      );
    }
    const existing = await tx.plc.findUnique({
      where: { edgeAgentId_externalPlcId: { edgeAgentId: agent.id, externalPlcId: document.plcId } },
    });
    if (existing && document.configVersion < existing.configVersion) {
      throw new DomainError(
        "CONFLICT",
        `Version ${document.configVersion} is older than the registered version ${existing.configVersion}.`,
        {
          rule: "stale-config",
        },
      );
    }
    if (existing && document.configVersion === existing.configVersion && document.checksum !== existing.checksum) {
      throw new DomainError("CONFLICT", `Version ${document.configVersion} is registered with other content.`, {
        rule: "config-version-reused",
      });
    }
    if (existing && document.checksum === existing.checksum && document.configVersion === existing.configVersion) {
      return { plcId: existing.id, created: false, unchanged: true };
    }

    const otherSite = await tx.factory.findFirst({
      where: { organizationId, externalFactoryId: body.site.factoryId, siteId: { not: agent.siteId } },
    });
    if (otherSite) {
      throw new DomainError("CONFLICT", `Factory ${body.site.factoryName} belongs to another site.`, {
        rule: "factory-site",
      });
    }
    const factory = await tx.factory.upsert({
      where: { siteId_externalFactoryId: { siteId: agent.siteId, externalFactoryId: body.site.factoryId } },
      create: {
        organizationId,
        siteId: agent.siteId,
        externalFactoryId: body.site.factoryId,
        name: body.site.factoryName,
        slug: body.site.factorySlug,
      },
      update: { name: body.site.factoryName, slug: body.site.factorySlug },
    });
    const data = {
      name: body.plc.name,
      role: body.plc.role,
      configVersion: document.configVersion,
      checksum: document.checksum,
      deploymentJson: document as unknown as Prisma.InputJsonValue,
      factoryId: factory.id,
    };
    const plc = existing
      ? await tx.plc.update({ where: { id: existing.id }, data })
      : await tx.plc.create({ data: { ...data, edgeAgentId: agent.id, externalPlcId: document.plcId } });

    await tx.plcMapping.deleteMany({ where: { plcId: plc.id } });
    if (body.mappings.length > 0) {
      await tx.plcMapping.createMany({
        data: body.mappings.map((mapping) => ({
          plcId: plc.id,
          externalId: mapping.id,
          name: mapping.name,
          access: mapping.access,
          role: mapping.role,
          dataType: mapping.dataType,
          unit: mapping.unit,
          min: mapping.min ?? null,
          max: mapping.max ?? null,
        })),
      });
    }
    await tx.plcModule.deleteMany({ where: { plcId: plc.id } });
    for (const entry of body.modules) {
      const moduleRecord = await tx.module.upsert({
        where: { factoryId_externalModuleId: { factoryId: factory.id, externalModuleId: entry.moduleId } },
        create: { factoryId: factory.id, externalModuleId: entry.moduleId, name: entry.name, type: entry.type },
        update: { name: entry.name, type: entry.type },
      });
      await tx.plcModule.create({ data: { plcId: plc.id, moduleId: moduleRecord.id } });
    }
    await audit(tx, {
      organizationId,
      actorUserId: actor.userId,
      action: existing ? "PLC_UPDATED" : "PLC_REGISTERED",
      subjectType: "PLC",
      subjectId: plc.id,
      detail: {
        plcId: document.plcId,
        name: body.plc.name,
        configVersion: document.configVersion,
        ...(existing ? { from: existing.configVersion } : {}),
        mappings: body.mappings.length,
        writable: body.mappings.filter((mapping) => mapping.access === "WRITE").length,
      },
    });
    return { plcId: plc.id, created: !existing, unchanged: false };
  });
}

/** The latest audit entries of an organization, for admins. */
export async function listAudit(db: Db, actor: Actor, organizationId: string, limit = 50) {
  await requireMembership(db, actor, organizationId, "manageUsers");
  return db.auditEvent.findMany({
    where: { organizationId },
    orderBy: { at: "desc" },
    take: Math.min(Math.max(limit, 1), 200),
    include: { actor: { select: { email: true } } },
  });
}
