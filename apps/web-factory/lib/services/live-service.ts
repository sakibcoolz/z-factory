import "server-only";
import { type Actor, isUuid } from "@/lib/auth/actor";
import type { Db } from "@/lib/db/client";
import { type ConnectivityLimits, DEFAULT_LIMITS } from "@/lib/domain/connectivity";
import { DomainError } from "@/lib/domain/errors";
import { listAlarms } from "./alarm-service";
import { getAgent, getSite } from "./site-service";
import { getLatest } from "./telemetry-service";

/**
 * What a live page shows, for one scope (TASK-904): built from the database each time, so
 * it is the same whichever Web Factory process serves the browser, and checked against
 * the actor each time, like any other read. The live stream (/api/v1/live) sends it again
 * whenever it changed.
 */

export type LiveScope = { kind: "plc" | "agent" | "site" | "org"; id: string };

export function parseScope(value: string | null): LiveScope {
  const match = /^(plc|agent|site|org):([0-9a-f-]{36})$/i.exec(value ?? "");
  if (!match || !isUuid(match[2]!))
    throw new DomainError("VALIDATION", "scope is plc:, agent:, site: or org: and an id.");
  return { kind: match[1]!.toLowerCase() as LiveScope["kind"], id: match[2]! };
}

async function organizationOf(db: Db, scope: LiveScope): Promise<string | null> {
  if (scope.kind === "org") return scope.id;
  if (scope.kind === "site") return (await db.site.findUnique({ where: { id: scope.id } }))?.organizationId ?? null;
  if (scope.kind === "agent") {
    return (
      (await db.edgeAgent.findUnique({ where: { id: scope.id }, include: { site: true } }))?.site.organizationId ?? null
    );
  }
  return (
    (await db.plc.findUnique({ where: { id: scope.id }, include: { agent: { include: { site: true } } } }))?.agent.site
      .organizationId ?? null
  );
}

export async function liveView(
  db: Db,
  actor: Actor,
  scope: LiveScope,
  limits: ConnectivityLimits = DEFAULT_LIMITS,
  now = new Date(),
) {
  const organizationId = await organizationOf(db, scope);
  if (!organizationId) throw new DomainError("NOT_FOUND", "The scope does not exist.");
  const narrow =
    scope.kind === "plc"
      ? { plcId: scope.id }
      : scope.kind === "agent"
        ? { agentId: scope.id }
        : scope.kind === "site"
          ? { siteId: scope.id }
          : {};
  // Membership is checked here; for another organization's scope this is NOT_FOUND.
  const { alarms, role } = await listAlarms(db, actor, organizationId, { state: "active", ...narrow });
  const base = { scope, at: now, role, alarms };
  if (scope.kind === "plc") {
    return { ...base, plc: await getLatest(db, actor, scope.id, limits, now) };
  }
  if (scope.kind === "agent") {
    const view = await getAgent(db, actor, scope.id, limits, now);
    return {
      ...base,
      agent: {
        id: view.agent.id,
        name: view.agent.name,
        // Without silentForMs, which changes every moment; the browser counts from lastSeenAt.
        connectivity: { state: view.connectivity.state, reasons: view.connectivity.reasons },
        lastSeenAt: view.agent.lastSeenAt,
        lastHeartbeatAt: view.agent.lastHeartbeatAt,
        agentVersion: view.agent.agentVersion,
        heartbeat: view.agent.heartbeatJson,
      },
      plcs: view.plcs.map((plc) => ({ id: plc.id, name: plc.name, edge: plc.edge })),
    };
  }
  if (scope.kind === "site") {
    const view = await getSite(db, actor, scope.id, limits, now);
    return {
      ...base,
      agents: view.agents.map((agent) => ({
        id: agent.id,
        name: agent.name,
        agentKey: agent.agentKey,
        connectivity: { state: agent.connectivity.state, reasons: agent.connectivity.reasons },
        lastSeenAt: agent.lastSeenAt,
        plcs: agent.plcs.map((plc) => ({ id: plc.id, name: plc.name })),
      })),
    };
  }
  return base;
}

export type LiveView = Awaited<ReturnType<typeof liveView>>;
