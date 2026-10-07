import { z } from "zod";

/**
 * What a Z-Factory Thin Client Agent publishes (docs/thin-client-agent.md → MQTT), as Web
 * Factory reads it. Web Factory imports no agent code: this is its own copy of the
 * contract, checked strictly where it matters (identity, times, states) and loosely on
 * counters, which may grow. Pure; importable anywhere.
 *
 *   zfactory/{siteId}/{agentId}/agent/status      online / offline (retained; also the will)
 *   zfactory/{siteId}/{agentId}/agent/heartbeat   alive, with counters (QoS 0, every interval)
 *   zfactory/{siteId}/{agentId}/state/{plcId}     a PLC worker's state (retained; empty = gone)
 *   zfactory/{siteId}/{agentId}/telemetry/{plcId} one poll of a PLC (TASK-903)
 *   zfactory/{siteId}/{agentId}/ack/{plcId}       what became of a command (TASK-905)
 *   zfactory/{siteId}/{agentId}/command/{plcId}   Web Factory → agent (TASK-905)
 */

export const TOPIC_SEGMENT = /^[A-Za-z0-9_-]{1,64}$/;

/** What Web Factory subscribes to: everything agents publish, nothing they receive. */
export const INGEST_SUBSCRIPTIONS = [
  "zfactory/+/+/agent/status",
  "zfactory/+/+/agent/heartbeat",
  "zfactory/+/+/state/+",
  "zfactory/+/+/telemetry/+",
  "zfactory/+/+/ack/+",
] as const;

export type AgentTopic =
  | { kind: "status" | "heartbeat"; siteKey: string; agentKey: string }
  | { kind: "state" | "telemetry" | "ack" | "command"; siteKey: string; agentKey: string; plcId: string };

/** The topic's parts, or null when it is not an agent topic. */
export function parseAgentTopic(topic: string): AgentTopic | null {
  const parts = topic.split("/");
  if (parts[0] !== "zfactory" || parts.length !== 5) return null;
  const [, siteKey, agentKey, area, last] = parts as [string, string, string, string, string];
  if (!TOPIC_SEGMENT.test(siteKey) || !TOPIC_SEGMENT.test(agentKey)) return null;
  if (area === "agent") {
    if (last === "status") return { kind: "status", siteKey, agentKey };
    if (last === "heartbeat") return { kind: "heartbeat", siteKey, agentKey };
    return null;
  }
  if (area === "state" || area === "telemetry" || area === "ack" || area === "command") {
    // The agent's plcId is Z-Factory's id (a uuid), but any id the deployment allows is a segment.
    if (!TOPIC_SEGMENT.test(last)) return null;
    return { kind: area, siteKey, agentKey, plcId: last };
  }
  return null;
}

/** The topic root of an agent: what it publishes under and what commands go to. */
export function agentTopicRoot(siteKey: string, agentKey: string): string {
  if (!TOPIC_SEGMENT.test(siteKey) || !TOPIC_SEGMENT.test(agentKey)) throw new Error("not an MQTT topic segment");
  return `zfactory/${siteKey}/${agentKey}`;
}

const time = z.coerce.date().refine((value) => !Number.isNaN(value.getTime()), "not a time");
const identity = { siteId: z.string().regex(TOPIC_SEGMENT), agentId: z.string().regex(TOPIC_SEGMENT) };
const counter = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

export const agentStatusSchema = z.object({
  schema: z.literal("zfactory.agent-status"),
  version: z.literal(1),
  ...identity,
  status: z.enum(["online", "offline"]),
  agentVersion: z.string().max(80).optional(),
  at: time,
});

export const agentHeartbeatSchema = z.object({
  schema: z.literal("zfactory.agent-heartbeat"),
  version: z.literal(1),
  ...identity,
  agentVersion: z.string().max(80).optional(),
  uptimeS: counter,
  workers: counter,
  byState: z.record(z.string().max(40), counter).default({}),
  queue: z.object({ depth: counter, dropped: counter }).partial().default({}),
  spooled: counter.default(0),
  published: counter.default(0),
  at: time,
});

/** The worker states the agent reports (internal/worker). Anything else is shown as sent. */
export const PLC_WORKER_STATES = ["CONNECTING", "ONLINE", "DEGRADED", "RECONNECTING", "DISCONNECTED", "STOPPING"];

export const plcStateSchema = z.object({
  schema: z.literal("zfactory.plc-state"),
  version: z.literal(1),
  ...identity,
  plcId: z.string().regex(TOPIC_SEGMENT),
  name: z.string().max(200).optional(),
  state: z.string().regex(/^[A-Z_]{1,40}$/),
  configVersion: z.number().int().min(0).max(2_147_483_647),
  endpoint: z.string().max(300).optional(),
  lastPollAt: time.nullable().optional(),
  lastError: z.string().max(2000).optional(),
  reconnects: counter.max(2_147_483_647).default(0),
  at: time,
});

export type AgentStatusMessage = z.infer<typeof agentStatusSchema>;
export type AgentHeartbeat = z.infer<typeof agentHeartbeatSchema>;
export type PlcStateMessage = z.infer<typeof plcStateSchema>;
