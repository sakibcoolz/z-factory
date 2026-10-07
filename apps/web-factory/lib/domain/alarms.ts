import { type ConnectivityLimits, DEFAULT_LIMITS, projectAgent } from "./connectivity";

/**
 * Which alarms should be active now (TASK-904, ADR-0021). Pure; importable anywhere.
 *
 * Sources and severities are fixed (owner decision); no rule is configured in the cloud:
 *
 *   PLC_TAG           HIGH    a tag with role ALARM reads true; the PLC program decides
 *   PLC_CONNECTION    HIGH    the PLC's connection is down, as its reachable agent reports it
 *   AGENT_CONNECTION  MEDIUM  the agent is offline or degraded
 *
 * Unknown is never shown as healthy: an alarm tag keeps its alarm while its last value was
 * true, whatever its quality now, and clears only on a value that is false. A PLC's
 * connection is judged only while its agent is reachable; when the agent is not, the
 * agent's own alarm says so instead of one alarm per PLC. An agent never heard from, or
 * whose credentials are revoked, raises nothing.
 */

export type AlarmSourceName = "PLC_TAG" | "PLC_CONNECTION" | "AGENT_CONNECTION";
export type AlarmSeverityName = "HIGH" | "MEDIUM" | "LOW";

export type AlarmCondition = {
  key: string;
  source: AlarmSourceName;
  severity: AlarmSeverityName;
  organizationId: string;
  siteId: string;
  agentId: string;
  plcId: string | null;
  subject: string;
  message: string;
};

export type AlarmFacts = {
  id: string;
  name: string;
  organizationId: string;
  siteId: string;
  status: "UNKNOWN" | "ONLINE" | "OFFLINE";
  lastSeenAt: Date | null;
  heartbeat: unknown;
  credentialRevokedAt: Date | null;
  plcs: Array<{
    id: string;
    name: string;
    edgeState: string | null;
    edgeLastError: string | null;
    /** Tags with role ALARM and their latest value (null: never read). */
    alarmTags: Array<{ tag: string; name: string; value: number | boolean | null }>;
  }>;
};

/** PLC worker states that mean the PLC cannot be reached. */
const DOWN = new Set(["DISCONNECTED", "RECONNECTING"]);

export const alarmKey = (source: AlarmSourceName, ref: string, subject = "") => `${source}|${ref}|${subject}`;

const truthy = (value: number | boolean | null) => value === true || (typeof value === "number" && value !== 0);

export function desiredAlarms(
  agents: AlarmFacts[],
  now: Date,
  options: { limits?: ConnectivityLimits; judgeConnectivity?: boolean } = {},
): AlarmCondition[] {
  const limits = options.limits ?? DEFAULT_LIMITS;
  const judgeConnectivity = options.judgeConnectivity ?? true;
  const alarms: AlarmCondition[] = [];
  for (const agent of agents) {
    const base = { organizationId: agent.organizationId, siteId: agent.siteId, agentId: agent.id };
    const connectivity = projectAgent(
      {
        status: agent.status,
        lastSeenAt: agent.lastSeenAt,
        heartbeat: agent.heartbeat,
        credentialRevokedAt: agent.credentialRevokedAt,
      },
      now,
      limits,
    );
    const reachable = connectivity.state === "ONLINE" || connectivity.state === "DEGRADED";
    if (judgeConnectivity && !agent.credentialRevokedAt && connectivity.state !== "UNKNOWN") {
      if (connectivity.state === "OFFLINE" || connectivity.state === "DEGRADED") {
        alarms.push({
          ...base,
          key: alarmKey("AGENT_CONNECTION", agent.id),
          source: "AGENT_CONNECTION",
          severity: "MEDIUM",
          plcId: null,
          subject: "",
          // Stable while the state lasts; the agent's page shows the reasons as they change.
          message: `Agent ${agent.name} is ${connectivity.state.toLowerCase()}`,
        });
      }
    }
    for (const plc of agent.plcs) {
      if (judgeConnectivity && reachable && plc.edgeState && DOWN.has(plc.edgeState)) {
        alarms.push({
          ...base,
          key: alarmKey("PLC_CONNECTION", plc.id),
          source: "PLC_CONNECTION",
          severity: "HIGH",
          plcId: plc.id,
          subject: "",
          message: `PLC ${plc.name} is ${plc.edgeState.toLowerCase()}${plc.edgeLastError ? `: ${plc.edgeLastError}` : ""}`,
        });
      }
      for (const tag of plc.alarmTags) {
        if (!truthy(tag.value)) continue;
        alarms.push({
          ...base,
          key: alarmKey("PLC_TAG", plc.id, tag.tag),
          source: "PLC_TAG",
          severity: "HIGH",
          plcId: plc.id,
          subject: tag.tag,
          message: `${tag.name} on ${plc.name}`,
        });
      }
    }
  }
  return alarms;
}
