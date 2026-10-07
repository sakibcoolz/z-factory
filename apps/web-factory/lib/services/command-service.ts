import "server-only";
import { z } from "zod";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { agentTopicRoot } from "@/lib/domain/agent-messages";
import {
  afterAck,
  type CommandAck,
  commandEnvelope,
  type CommandMapping,
  type CommandStatusName,
  checkValue,
  DEFAULT_TTL_MS,
  sameValue,
} from "@/lib/domain/commands";
import { type ConnectivityLimits, DEFAULT_LIMITS, projectAgent } from "@/lib/domain/connectivity";
import type { EdgeDeploymentDocument } from "@/lib/domain/edge-deployment";
import { DomainError } from "@/lib/domain/errors";
import { Prisma, type PrismaClient } from "@/lib/generated/prisma/client";
import { audit } from "./audit-service";

/**
 * Commands and setpoints (TASK-905, ADR-0022).
 *
 * issueCommand checks, records, audits and publishes one command:
 * - the actor may command (operators and admins); a viewer is refused and that is audited;
 * - the tag is checked against the PLC's registered deployment (writable command or
 *   setpoint, value type and range); a refusal is recorded as a REJECTED command;
 * - the agent must be reachable with valid credentials, or the command would only expire;
 * - the same form sent twice (its request key) is one command;
 * - the command is published with QoS 1 to zfactory/{site}/{agent}/command/{plc}, expiring
 *   after a minute; if the broker cannot take it, it is FAILED and nothing reached a PLC.
 *
 * The agent answers on ack/{plc}; applyAck moves the command on (never back), and
 * expireCommands marks those left without a final answer TIMED_OUT.
 */

export type CommandPublisher = (topic: string, payload: string) => Promise<void>;

const issueSchema = z.object({
  tag: z.string().min(1).max(64),
  value: z.union([z.boolean(), z.number()]),
  requestKey: z.string().min(8).max(64),
});

const notFound = () => new DomainError("NOT_FOUND", "The PLC does not exist.");

type IssueOptions = { limits?: ConnectivityLimits; ttlMs?: number; now?: Date };

export async function issueCommand(
  db: PrismaClient,
  publish: CommandPublisher | null,
  actor: Actor,
  plcId: string,
  input: unknown,
  options: IssueOptions = {},
) {
  const plc = isUuid(plcId)
    ? await db.plc.findUnique({ where: { id: plcId }, include: { agent: { include: { site: true } } } })
    : null;
  if (!plc) throw notFound();
  const organizationId = plc.agent.site.organizationId;
  await requireMembership(db, actor, organizationId, "command").catch(async (error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound();
    if (error instanceof DomainError && error.code === "FORBIDDEN") {
      await audit(db, {
        organizationId,
        actorUserId: actor.userId,
        action: "COMMAND_REFUSED",
        subjectType: "PLC",
        subjectId: plc.id,
        detail: { rule: "not-allowed" },
      });
    }
    throw error;
  });
  const parsed = issueSchema.safeParse(input);
  if (!parsed.success) {
    throw new DomainError("VALIDATION", parsed.error.issues[0]?.message ?? "Invalid command.", {
      rule: "command-input",
    });
  }
  const { tag, value, requestKey } = parsed.data;

  // The same form sent again: the command it already made.
  const existing = await db.command.findUnique({
    where: { requestedBy_requestKey: { requestedBy: actor.userId, requestKey } },
  });
  if (existing) return { command: existing, repeated: true };

  const now = options.now ?? new Date();
  const document = plc.deploymentJson as unknown as EdgeDeploymentDocument;
  const mapping = document.deployment.mappings.find((entry) => entry.id === tag);
  const base = {
    organizationId,
    siteId: plc.agent.siteId,
    agentId: plc.edgeAgentId,
    plcId: plc.id,
    tag,
    tagName: mapping?.name ?? tag,
    valueNum: typeof value === "number" ? value : null,
    valueBool: typeof value === "boolean" ? value : null,
    configVersion: plc.configVersion,
    requestedBy: actor.userId,
    requestKey,
    requestedAt: now,
    expiresAt: new Date(now.getTime() + (options.ttlMs ?? DEFAULT_TTL_MS)),
  };

  const refuse = async (rule: string, reason: string) => {
    const command = await db.command.create({
      data: { ...base, status: "REJECTED", rule, reason, completedAt: now },
    });
    await audit(db, {
      organizationId,
      actorUserId: actor.userId,
      action: "COMMAND_REJECTED",
      subjectType: "COMMAND",
      subjectId: command.id,
      detail: { plcId: plc.id, tag, value, rule },
    });
    return { command, repeated: false };
  };

  if (!mapping) return refuse("unknown-tag", `${plc.name} has no tag ${tag}.`);
  const checked = checkValue(
    {
      externalId: mapping.id,
      name: mapping.name,
      access: mapping.access,
      role: mapping.role,
      authority: mapping.authority,
      dataType: mapping.dataType,
      min: mapping.min ?? null,
      max: mapping.max ?? null,
    } satisfies CommandMapping,
    value,
  );
  if (!checked.ok) return refuse(checked.rule, checked.reason);
  const agent = plc.agent;
  if (agent.credentialRevokedAt || !agent.brokerUsername) {
    return refuse("agent-not-onboarded", `${agent.name} has no valid broker credentials.`);
  }
  const connectivity = projectAgent(
    {
      status: agent.status,
      lastSeenAt: agent.lastSeenAt,
      heartbeat: agent.heartbeatJson,
      credentialRevokedAt: agent.credentialRevokedAt,
    },
    now,
    options.limits ?? DEFAULT_LIMITS,
  );
  if (connectivity.state === "OFFLINE" || connectivity.state === "UNKNOWN") {
    return refuse("agent-offline", `${agent.name} is not connected; the command would only expire.`);
  }

  let command;
  try {
    command = await db.command.create({ data: { ...base, status: "REQUESTED" } });
  } catch (error) {
    // The same form, sent twice at once: the other request made the command.
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      const twin = await db.command.findUniqueOrThrow({
        where: { requestedBy_requestKey: { requestedBy: actor.userId, requestKey } },
      });
      return { command: twin, repeated: true };
    }
    throw error;
  }
  await audit(db, {
    organizationId,
    actorUserId: actor.userId,
    action: "COMMAND_REQUESTED",
    subjectType: "COMMAND",
    subjectId: command.id,
    detail: { plcId: plc.id, tag, tagName: mapping.name, value: checked.value, configVersion: plc.configVersion },
  });

  const topic = `${agentTopicRoot(agent.site.siteKey, agent.agentKey)}/command/${plc.externalPlcId}`;
  const payload = JSON.stringify(
    commandEnvelope({
      commandId: command.id,
      plcId: plc.externalPlcId,
      mappingId: mapping.id,
      value: checked.value,
      configVersion: plc.configVersion,
      issuedAt: now,
      expiresAt: base.expiresAt,
      requestedBy: actor.userId,
    }),
  );
  try {
    if (!publish) throw new Error("MQTT is not configured");
    await publish(topic, payload);
  } catch (error) {
    const failed = await db.command.update({
      where: { id: command.id },
      data: {
        status: "FAILED",
        rule: "broker-unavailable",
        reason: `Not published: ${error instanceof Error ? error.message : "the broker could not be reached"}. Nothing reached the PLC.`,
        completedAt: new Date(),
      },
    });
    return { command: failed, repeated: false };
  }
  // An acknowledgement may already have moved it on.
  await db.command.updateMany({
    where: { id: command.id, status: "REQUESTED" },
    data: { status: "PUBLISHED", publishedAt: new Date() },
  });
  await db.command.updateMany({ where: { id: command.id, publishedAt: null }, data: { publishedAt: new Date() } });
  return { command: await db.command.findUniqueOrThrow({ where: { id: command.id } }), repeated: false };
}

/**
 * Applies an agent's acknowledgement. Returns why it was not applied, for the ingest
 * counters: an unknown command, one of another agent or PLC, or a redelivery.
 */
export async function applyAck(
  db: PrismaClient,
  agentId: string,
  topicPlcId: string,
  ack: CommandAck,
  receivedAt = new Date(),
): Promise<"applied" | "duplicate" | "unchanged" | "unknown-command"> {
  if (!isUuid(ack.commandId)) return "unknown-command";
  const command = await db.command.findUnique({ where: { id: ack.commandId } });
  if (!command || command.agentId !== agentId) return "unknown-command";
  const plc = await db.plc.findUnique({ where: { id: command.plcId }, select: { externalPlcId: true } });
  if (!plc || plc.externalPlcId !== topicPlcId) return "unknown-command";
  if (ack.duplicate) {
    await db.command.update({ where: { id: command.id }, data: { duplicateAcks: { increment: 1 } } });
    return "duplicate";
  }
  const next = afterAck(command.status as CommandStatusName, ack);
  if (!next) return "unchanged";
  const final = next.status !== "ACCEPTED";
  const { count } = await db.command.updateMany({
    where: { id: command.id, status: command.status },
    data: {
      status: next.status,
      lateAnswer: next.late || undefined,
      ...(next.status === "ACCEPTED" ? { acceptedAt: ack.at } : {}),
      ...(final
        ? {
            completedAt: ack.at,
            rule: ack.rule ?? null,
            reason: ack.reason ?? null,
            observedJson: ack.observed === undefined ? Prisma.JsonNull : (ack.observed as Prisma.InputJsonValue),
          }
        : {}),
      ...(command.publishedAt ? {} : { publishedAt: receivedAt }),
    },
  });
  if (count === 0) return "unchanged";
  if (final) {
    await audit(db, {
      organizationId: command.organizationId,
      actorUserId: null,
      action: `COMMAND_${next.status}`,
      subjectType: "COMMAND",
      subjectId: command.id,
      detail: { rule: ack.rule ?? null, late: next.late },
    });
  }
  return "applied";
}

/** Marks commands left without a final answer after they expired (and a grace) TIMED_OUT. */
export async function expireCommands(db: PrismaClient, now = new Date(), graceMs = 10_000): Promise<number> {
  const { count } = await db.command.updateMany({
    where: {
      status: { in: ["REQUESTED", "PUBLISHED", "ACCEPTED"] },
      expiresAt: { lt: new Date(now.getTime() - graceMs) },
    },
    data: {
      status: "TIMED_OUT",
      completedAt: now,
      rule: "no-answer",
      reason: "No final answer from the agent before the command expired.",
    },
  });
  return count;
}

const listSchema = z.object({ limit: z.coerce.number().int().min(1).max(500).default(50) });

/** A PLC's recent commands, newest first, each with who asked and what telemetry showed. */
export async function listCommands(db: Db, actor: Actor, plcId: string, input: Record<string, unknown> = {}) {
  const plc = isUuid(plcId)
    ? await db.plc.findUnique({ where: { id: plcId }, include: { agent: { include: { site: true } } } })
    : null;
  if (!plc) throw notFound();
  const { role } = await requireMembership(db, actor, plc.agent.site.organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") throw notFound();
    throw error;
  });
  const { limit } = listSchema.parse(input);
  const commands = await db.command.findMany({
    where: { plcId: plc.id },
    orderBy: { requestedAt: "desc" },
    take: limit,
  });
  return { role, commands: await withViews(db, commands) };
}

/** One command, for whoever may see its PLC. */
export async function getCommand(db: Db, actor: Actor, commandId: string) {
  const command = isUuid(commandId) ? await db.command.findUnique({ where: { id: commandId } }) : null;
  if (!command) throw new DomainError("NOT_FOUND", "The command does not exist.");
  await requireMembership(db, actor, command.organizationId, "view").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      throw new DomainError("NOT_FOUND", "The command does not exist.");
    }
    throw error;
  });
  return (await withViews(db, [command]))[0]!;
}

type CommandRow = Prisma.CommandGetPayload<object>;

/**
 * Adds who asked, and the first telemetry after the write that shows the commanded value:
 * the PLC's own feedback that the command or setpoint holds.
 */
async function withViews(db: Db, commands: CommandRow[]) {
  const users = new Map(
    (
      await db.user.findMany({
        where: { id: { in: [...new Set(commands.map((command) => command.requestedBy))] } },
        select: { id: true, name: true, email: true },
      })
    ).map((user) => [user.id, user]),
  );
  const views = [];
  for (const command of commands) {
    const value = command.valueBool ?? command.valueNum;
    let confirmedAt: Date | null = null;
    if (command.status === "APPLIED" && command.completedAt && value !== null) {
      const samples = await db.$queryRawUnsafe<
        Array<{ at: Date; value_num: number | null; value_bool: boolean | null }>
      >(
        `SELECT at, value_num, value_bool FROM telemetry.sample
         WHERE plc_id = $1::uuid AND tag = $2 AND at >= $3 AND at < $4 ORDER BY at LIMIT 50`,
        command.plcId,
        command.tag,
        new Date(command.completedAt.getTime() - 1000),
        new Date(command.completedAt.getTime() + 5 * 60_000),
      );
      const match = samples.find((sample) => sameValue(value, sample.value_bool ?? sample.value_num));
      confirmedAt = match ? new Date(match.at) : null;
    }
    const user = users.get(command.requestedBy);
    views.push({
      id: command.id,
      tag: command.tag,
      tagName: command.tagName,
      value,
      configVersion: command.configVersion,
      status: command.status,
      rule: command.rule,
      reason: command.reason,
      observed: command.observedJson as number | boolean | null,
      duplicateAcks: command.duplicateAcks,
      lateAnswer: command.lateAnswer,
      requestedBy: user ? `${user.name}` : "a former user",
      requestedAt: command.requestedAt,
      publishedAt: command.publishedAt,
      acceptedAt: command.acceptedAt,
      completedAt: command.completedAt,
      expiresAt: command.expiresAt,
      confirmedAt,
    });
  }
  return views;
}
