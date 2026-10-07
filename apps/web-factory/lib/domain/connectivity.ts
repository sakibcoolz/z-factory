/**
 * The connectivity Web Factory shows for an agent and its PLCs, projected from what the
 * agent last reported and when it was last heard from (TASK-902). Pure; importable anywhere.
 *
 *   UNKNOWN   registered, never heard from
 *   ONLINE    said it is online, heartbeats on time, every PLC worker online, nothing spooled
 *   DEGRADED  online, but the heartbeat is late, a PLC worker is not online, or telemetry
 *             waits in the agent's spool
 *   OFFLINE   said it went offline (or its will did), or silent past the offline limit
 *
 * Time comes from Web Factory's clock (lastSeenAt), never from the agent's, so a wrong
 * clock at the edge cannot make an agent look alive.
 */

export type Connectivity = "UNKNOWN" | "ONLINE" | "DEGRADED" | "OFFLINE";

export type ConnectivityLimits = {
  /** The agents' heartbeat interval (ZFACTORY_AGENT_HEARTBEAT; 10 s by default). */
  heartbeatMs: number;
};

export const DEFAULT_LIMITS: ConnectivityLimits = { heartbeatMs: 10_000 };

/** Late after two and a half intervals without a word, offline after six. */
export const lateAfterMs = (limits: ConnectivityLimits) => limits.heartbeatMs * 2.5;
export const offlineAfterMs = (limits: ConnectivityLimits) => limits.heartbeatMs * 6;

export type AgentFacts = {
  status: "UNKNOWN" | "ONLINE" | "OFFLINE";
  lastSeenAt: Date | null;
  /** The last heartbeat's counters, as stored. */
  heartbeat: unknown;
  credentialRevokedAt?: Date | null;
};

export type AgentConnectivity = { state: Connectivity; reasons: string[]; silentForMs: number | null };

const seconds = (ms: number) => `${Math.round(ms / 1000)} s`;

function heartbeatIssues(heartbeat: unknown): string[] {
  if (typeof heartbeat !== "object" || heartbeat === null) return [];
  const { workers, byState, spooled } = heartbeat as { workers?: unknown; byState?: unknown; spooled?: unknown };
  const reasons: string[] = [];
  if (typeof workers === "number" && typeof byState === "object" && byState !== null) {
    const online = Number((byState as Record<string, unknown>).ONLINE ?? 0);
    const notOnline = workers - (Number.isFinite(online) ? online : 0);
    if (notOnline > 0) reasons.push(`${notOnline} of ${workers} PLC workers not online`);
  }
  if (typeof spooled === "number" && spooled > 0) reasons.push(`${spooled} telemetry batches waiting in the spool`);
  return reasons;
}

export function projectAgent(
  facts: AgentFacts,
  now: Date,
  limits: ConnectivityLimits = DEFAULT_LIMITS,
): AgentConnectivity {
  const silentForMs = facts.lastSeenAt ? Math.max(0, now.getTime() - facts.lastSeenAt.getTime()) : null;
  if (facts.credentialRevokedAt) {
    return { state: "OFFLINE", reasons: ["its broker credentials are revoked"], silentForMs };
  }
  if (facts.status === "UNKNOWN" && silentForMs === null) {
    return { state: "UNKNOWN", reasons: [], silentForMs };
  }
  if (facts.status === "OFFLINE") {
    return { state: "OFFLINE", reasons: ["the agent reported it went offline"], silentForMs };
  }
  if (silentForMs === null) {
    // Only a retained status, never a live message: nothing proves it is there now.
    return { state: "OFFLINE", reasons: ["no live message since Web Factory started listening"], silentForMs };
  }
  if (silentForMs > offlineAfterMs(limits)) {
    return { state: "OFFLINE", reasons: [`silent for ${seconds(silentForMs)}`], silentForMs };
  }
  const reasons = heartbeatIssues(facts.heartbeat);
  if (silentForMs > lateAfterMs(limits)) reasons.unshift(`heartbeat late: last heard ${seconds(silentForMs)} ago`);
  return { state: reasons.length > 0 ? "DEGRADED" : "ONLINE", reasons, silentForMs };
}

export type PlcFacts = { edgeState: string | null; edgeLastError: string | null };

/** A PLC's connection as its agent last reported it; unknown while the agent is offline. */
export function projectPlc(plc: PlcFacts, agent: Connectivity): { state: string; note: string | null } {
  if (agent === "OFFLINE" || agent === "UNKNOWN") {
    return { state: "UNKNOWN", note: plc.edgeState ? `last reported ${plc.edgeState.toLowerCase()}` : null };
  }
  if (!plc.edgeState) return { state: "UNKNOWN", note: "not reported by the agent" };
  if (plc.edgeState === "REMOVED") return { state: "REMOVED", note: "the agent no longer runs this PLC" };
  return { state: plc.edgeState, note: plc.edgeState === "ONLINE" ? null : plc.edgeLastError || null };
}

export const CONNECTIVITY_LABELS: Record<Connectivity, string> = {
  UNKNOWN: "not heard from yet",
  ONLINE: "online",
  DEGRADED: "degraded",
  OFFLINE: "offline",
};
