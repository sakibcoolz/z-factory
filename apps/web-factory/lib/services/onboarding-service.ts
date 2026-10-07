import "server-only";
import { randomBytes } from "node:crypto";
import { type Actor, isUuid, requireMembership } from "@/lib/auth/actor";
import { agentTopicRoot } from "@/lib/domain/agent-messages";
import { agentBrokerIdentity } from "@/lib/domain/broker-access";
import { DomainError } from "@/lib/domain/errors";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type BrokerAdmin, BrokerUnavailableError } from "@/lib/mqtt/dynsec";
import { audit } from "./audit-service";

/**
 * Agent onboarding (TASK-902, ADR-0019): an administrator issues an agent its own broker
 * credentials. Web Factory creates a Dynamic Security client bound to the agent's client id
 * with a role for the agent's own topics only, and shows the password once. The password
 * is not stored or logged anywhere; issuing again replaces it (rotation) and ends the
 * connection made with the old one. Revoking disables the client, which also disconnects it.
 *
 * The broker comes first: if it cannot be reached nothing changes, and a retry is safe
 * because every broker step can be repeated.
 */

export type IssuedCredentials = {
  username: string;
  clientId: string;
  /** Shown once, to the administrator who issued it. */
  password: string;
  siteKey: string;
  agentKey: string;
  topicRoot: string;
  rotated: boolean;
};

const unavailable = (reason: string) =>
  new DomainError("UNAVAILABLE", `The MQTT broker cannot be reached (${reason}); nothing changed.`);

async function adminAgent(db: PrismaClient, actor: Actor, agentId: string) {
  const agent = isUuid(agentId)
    ? await db.edgeAgent.findUnique({ where: { id: agentId }, include: { site: true } })
    : null;
  if (!agent) throw new DomainError("NOT_FOUND", "The agent does not exist.");
  await requireMembership(db, actor, agent.site.organizationId, "manageSites").catch((error: unknown) => {
    if (error instanceof DomainError && error.code === "NOT_FOUND") {
      throw new DomainError("NOT_FOUND", "The agent does not exist.");
    }
    throw error;
  });
  return agent;
}

async function onBroker(work: () => Promise<void>): Promise<void> {
  try {
    await work();
  } catch (error) {
    if (error instanceof BrokerUnavailableError) throw unavailable(error.message);
    // A refused Dynamic Security command: the account may lack the dynsec-admin role.
    throw new DomainError("UNAVAILABLE", "The MQTT broker refused the change; check Web Factory's broker account.", {
      reason: error instanceof Error ? error.message : "unknown",
    });
  }
}

export async function issueAgentCredentials(
  db: PrismaClient,
  broker: BrokerAdmin | null,
  actor: Actor,
  agentId: string,
): Promise<IssuedCredentials> {
  const agent = await adminAgent(db, actor, agentId);
  if (!broker) throw new DomainError("UNAVAILABLE", "MQTT is not configured for Web Factory (WEB_FACTORY_MQTT_URL).");
  const identity = agentBrokerIdentity(agent.site.siteKey, agent.agentKey);
  // Two agents could derive the same client id (site "a-b" + agent "c", site "a" + agent "b-c").
  const clash = await db.edgeAgent.findFirst({
    where: {
      id: { not: agent.id },
      OR: [{ brokerClientId: identity.clientId }, { brokerUsername: identity.username }],
    },
    select: { id: true },
  });
  if (clash) {
    throw new DomainError(
      "CONFLICT",
      `Another agent uses the MQTT client id ${identity.clientId}; rename this agent's id first.`,
      { rule: "client-id" },
    );
  }
  const password = randomBytes(24).toString("base64url");
  await onBroker(() => broker.ensureAgentClient(identity, password));
  const rotated = agent.credentialIssuedAt !== null && agent.credentialRevokedAt === null;
  await db.edgeAgent.update({
    where: { id: agent.id },
    data: {
      brokerUsername: identity.username,
      brokerClientId: identity.clientId,
      credentialIssuedAt: new Date(),
      credentialRevokedAt: null,
    },
  });
  await audit(db, {
    organizationId: agent.site.organizationId,
    actorUserId: actor.userId,
    action: rotated ? "AGENT_CREDENTIALS_ROTATED" : "AGENT_CREDENTIALS_ISSUED",
    subjectType: "AGENT",
    subjectId: agent.id,
    detail: { username: identity.username, clientId: identity.clientId },
  });
  return {
    username: identity.username,
    clientId: identity.clientId,
    password,
    siteKey: agent.site.siteKey,
    agentKey: agent.agentKey,
    topicRoot: agentTopicRoot(agent.site.siteKey, agent.agentKey),
    rotated,
  };
}

export async function revokeAgentCredentials(
  db: PrismaClient,
  broker: BrokerAdmin | null,
  actor: Actor,
  agentId: string,
): Promise<void> {
  const agent = await adminAgent(db, actor, agentId);
  if (!agent.brokerUsername || agent.credentialRevokedAt) {
    throw new DomainError("CONFLICT", "This agent has no broker credentials to revoke.", { rule: "not-issued" });
  }
  if (!broker) throw new DomainError("UNAVAILABLE", "MQTT is not configured for Web Factory (WEB_FACTORY_MQTT_URL).");
  const username = agent.brokerUsername;
  await onBroker(() => broker.disableClient(username));
  await db.edgeAgent.update({ where: { id: agent.id }, data: { credentialRevokedAt: new Date() } });
  await audit(db, {
    organizationId: agent.site.organizationId,
    actorUserId: actor.userId,
    action: "AGENT_CREDENTIALS_REVOKED",
    subjectType: "AGENT",
    subjectId: agent.id,
    detail: { username },
  });
}
