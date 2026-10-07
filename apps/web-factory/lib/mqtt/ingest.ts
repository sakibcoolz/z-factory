import "server-only";
import type { z } from "zod";
import {
  agentHeartbeatSchema,
  agentStatusSchema,
  type AgentTopic,
  parseAgentTopic,
  plcStateSchema,
} from "@/lib/domain/agent-messages";
import { type CommandAck, commandAckSchema } from "@/lib/domain/commands";
import { telemetryBatchSchema } from "@/lib/domain/telemetry";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import type { TelemetryOffer } from "@/lib/telemetry/pipeline";

/**
 * Turns what agents publish into connectivity state (TASK-902): an agent's reported
 * status, last-seen time and heartbeat, and each PLC worker's state.
 *
 * - One agent's messages are applied one at a time, in the order the broker delivered
 *   them; agents do not wait for each other. A heartbeat waiting behind another is replaced
 *   by the newer one.
 * - Retained messages (what the broker replays when Web Factory subscribes) are the
 *   broker's latest word and are applied, but never count as the agent being seen now.
 * - Applying the same message twice changes nothing: rows are updated in place, and a
 *   connection event is recorded only when the status actually changes.
 * - A message is dropped, and counted by reason, when its topic is not an agent topic, the
 *   agent or PLC is not registered, its credentials are revoked, or its body names another
 *   agent than its topic.
 *
 * Telemetry (TASK-903) is checked here and handed to the telemetry pipeline, which stores
 * it; a change of a PLC's reported state is recorded as an event. Command acknowledgements
 * (TASK-905) move their command on.
 */

export const MAX_PAYLOAD_BYTES = 1 << 20;

export type DropReason =
  | "topic"
  | "too-large"
  | "not-ingested"
  | "malformed"
  | "identity"
  | "unknown-agent"
  | "revoked"
  | "unknown-plc"
  | "unknown-command";

export type IngestStats = {
  received: number;
  applied: number;
  coalesced: number;
  transitions: number;
  errors: number;
  /** Command acknowledgements by outcome: applied, duplicate, unchanged, unknown-command. */
  acks: Record<string, number>;
  dropped: Record<DropReason, number>;
  lastMessageAt: string | null;
};

type AgentRef = { id: string; revoked: boolean };

export type IngestOptions = {
  now?: () => Date;
  /** How long a known (or unknown) agent is remembered before it is looked up again. */
  agentCacheMs?: number;
  /** Telemetry refreshes the stored last-seen time at most this often per agent. */
  seenWriteMs?: number;
  /** Where checked telemetry batches go (TASK-903); without one they only refresh last-seen. */
  telemetry?: { offer(offer: TelemetryOffer): void };
  /** Where command acknowledgements go (TASK-905); without it they only refresh last-seen. */
  commands?: {
    applyAck(agentId: string, topicPlcId: string, ack: CommandAck, receivedAt: Date): Promise<string>;
  };
  onError?: (error: unknown, topic: string) => void;
};

type Work = { topic: AgentTopic; raw: string; payload: Buffer; retained: boolean; receivedAt: Date };

export class Ingestor {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly heartbeats = new Map<string, Work>();
  private readonly agents = new Map<string, { ref: AgentRef | null; until: number }>();
  private readonly seenWrites = new Map<string, number>();
  private readonly now: () => Date;
  private readonly agentCacheMs: number;
  private readonly seenWriteMs: number;
  readonly stats: IngestStats = {
    received: 0,
    applied: 0,
    coalesced: 0,
    transitions: 0,
    errors: 0,
    acks: {},
    dropped: {
      topic: 0,
      "too-large": 0,
      "not-ingested": 0,
      malformed: 0,
      identity: 0,
      "unknown-agent": 0,
      revoked: 0,
      "unknown-plc": 0,
      "unknown-command": 0,
    },
    lastMessageAt: null,
  };

  constructor(
    private readonly db: PrismaClient,
    private readonly options: IngestOptions = {},
  ) {
    this.now = options.now ?? (() => new Date());
    this.agentCacheMs = options.agentCacheMs ?? 15_000;
    this.seenWriteMs = options.seenWriteMs ?? 5_000;
  }

  /** Takes one message off the broker connection; never throws and never blocks. */
  handle(raw: string, payload: Buffer, retained = false): void {
    const receivedAt = this.now();
    this.stats.received += 1;
    this.stats.lastMessageAt = receivedAt.toISOString();
    const topic = parseAgentTopic(raw);
    if (!topic) return this.drop("topic");
    if (payload.length > MAX_PAYLOAD_BYTES) return this.drop("too-large");
    if (topic.kind === "command") return this.drop("not-ingested");
    const key = `${topic.siteKey}/${topic.agentKey}`;
    const work: Work = { topic, raw, payload, retained, receivedAt };
    if (topic.kind === "heartbeat") {
      if (this.heartbeats.has(key)) {
        this.stats.coalesced += 1;
        this.heartbeats.set(key, work);
        return;
      }
      this.heartbeats.set(key, work);
      return this.enqueue(key, async () => {
        const latest = this.heartbeats.get(key);
        this.heartbeats.delete(key);
        if (latest) await this.apply(latest);
      });
    }
    this.enqueue(key, () => this.apply(work));
  }

  /** Resolves when everything taken so far is applied (tests, shutdown). */
  async idle(): Promise<void> {
    while (this.chains.size > 0) await Promise.all([...this.chains.values()]);
  }

  /** Forgets a cached agent, e.g. after its credentials changed. */
  forget(siteKey: string, agentKey: string): void {
    this.agents.delete(`${siteKey}/${agentKey}`);
  }

  private drop(reason: DropReason): void {
    this.stats.dropped[reason] += 1;
  }

  private enqueue(key: string, work: () => Promise<void>): void {
    const next = (this.chains.get(key) ?? Promise.resolve()).then(work).catch((error: unknown) => {
      this.stats.errors += 1;
      this.options.onError?.(error, key);
    });
    this.chains.set(key, next);
    void next.then(() => {
      if (this.chains.get(key) === next) this.chains.delete(key);
    });
  }

  private async agent(siteKey: string, agentKey: string): Promise<AgentRef | null> {
    const key = `${siteKey}/${agentKey}`;
    const cached = this.agents.get(key);
    if (cached && cached.until > Date.now()) return cached.ref;
    const row = await this.db.edgeAgent.findFirst({
      where: { agentKey, site: { siteKey } },
      select: { id: true, credentialRevokedAt: true },
    });
    const ref = row ? { id: row.id, revoked: row.credentialRevokedAt !== null } : null;
    this.agents.set(key, { ref, until: Date.now() + this.agentCacheMs });
    return ref;
  }

  private body<T extends z.ZodType>(schema: T, work: Work): z.infer<T> | null {
    let json: unknown;
    try {
      json = JSON.parse(work.payload.toString("utf8"));
    } catch {
      this.drop("malformed");
      return null;
    }
    const result = schema.safeParse(json);
    if (!result.success) {
      this.drop("malformed");
      return null;
    }
    const body = result.data as { siteId: string; agentId: string; plcId?: string };
    const { topic } = work;
    if (
      body.siteId !== topic.siteKey ||
      body.agentId !== topic.agentKey ||
      ("plcId" in topic && body.plcId !== undefined && body.plcId !== topic.plcId)
    ) {
      this.drop("identity");
      return null;
    }
    return result.data;
  }

  /** The last-seen fields of a live message; nothing for a retained one. */
  private seen(work: Work, key: string): { lastSeenAt?: Date } {
    if (work.retained) return {};
    this.seenWrites.set(key, work.receivedAt.getTime());
    return { lastSeenAt: work.receivedAt };
  }

  private async apply(work: Work): Promise<void> {
    const { topic } = work;
    const key = `${topic.siteKey}/${topic.agentKey}`;
    const agent = await this.agent(topic.siteKey, topic.agentKey);
    if (!agent) return this.drop("unknown-agent");
    if (agent.revoked) return this.drop("revoked");

    switch (topic.kind) {
      case "status": {
        const body = this.body(agentStatusSchema, work);
        if (!body) return;
        const status = body.status === "online" ? "ONLINE" : "OFFLINE";
        await this.setStatus(agent.id, status, work, key, {
          statusAt: body.at,
          ...(body.agentVersion ? { agentVersion: body.agentVersion } : {}),
        });
        break;
      }
      case "heartbeat": {
        const body = this.body(agentHeartbeatSchema, work);
        if (!body) return;
        const { schema: _schema, version: _version, siteId: _siteId, agentId: _agentId, ...counters } = body;
        const data = {
          heartbeatJson: { ...counters, at: body.at.toISOString() },
          ...(body.agentVersion ? { agentVersion: body.agentVersion } : {}),
          ...(work.retained ? {} : { lastHeartbeatAt: work.receivedAt }),
        };
        // An agent that sends heartbeats is connected, whatever was retained before.
        if (!work.retained) await this.setStatus(agent.id, "ONLINE", work, key, data);
        else await this.db.edgeAgent.update({ where: { id: agent.id }, data });
        break;
      }
      case "state": {
        const plc = await this.db.plc.findUnique({
          where: { edgeAgentId_externalPlcId: { edgeAgentId: agent.id, externalPlcId: topic.plcId } },
          select: { id: true },
        });
        if (!plc) {
          await this.touch(agent.id, work, key);
          return this.drop("unknown-plc");
        }
        if (work.payload.length === 0) {
          // The agent cleared the retained state: it no longer runs this PLC.
          await this.setPlcState(plc.id, "REMOVED", work.receivedAt, {});
        } else {
          const body = this.body(plcStateSchema, work);
          if (!body) return;
          await this.setPlcState(plc.id, body.state, body.at, {
            edgeConfigVersion: body.configVersion,
            edgeLastPollAt: body.lastPollAt ?? null,
            edgeLastError: body.lastError || null,
            edgeReconnects: body.reconnects,
          });
        }
        await this.touch(agent.id, work, key);
        break;
      }
      case "telemetry": {
        const body = this.body(telemetryBatchSchema, work);
        await this.touch(agent.id, work, key);
        if (!body) return;
        this.options.telemetry?.offer({ agentId: agent.id, message: body, receivedAt: work.receivedAt });
        break;
      }
      case "ack": {
        await this.touch(agent.id, work, key);
        let parsed;
        try {
          parsed = commandAckSchema.safeParse(JSON.parse(work.payload.toString("utf8")));
        } catch {
          return this.drop("malformed");
        }
        if (!parsed.success) return this.drop("malformed");
        // An ack names no site or agent: its topic does, and the command must be this agent's.
        const outcome =
          (await this.options.commands?.applyAck(agent.id, topic.plcId, parsed.data, work.receivedAt)) ?? "ignored";
        this.stats.acks[outcome] = (this.stats.acks[outcome] ?? 0) + 1;
        if (outcome === "unknown-command") return this.drop("unknown-command");
        break;
      }
    }
    this.stats.applied += 1;
  }

  /** Sets the reported status; a change is recorded once, with Web Factory's time. */
  private async setStatus(
    agentId: string,
    status: "ONLINE" | "OFFLINE",
    work: Work,
    key: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const fields = { ...data, ...this.seen(work, key) };
    const changed = await this.db.$transaction(async (tx) => {
      const { count } = await tx.edgeAgent.updateMany({
        where: { id: agentId, NOT: { status } },
        data: { ...fields, status },
      });
      if (count === 0) {
        if (Object.keys(fields).length > 0) await tx.edgeAgent.update({ where: { id: agentId }, data: fields });
        return false;
      }
      await tx.agentConnectionEvent.createMany({
        data: [{ edgeAgentId: agentId, status, at: work.receivedAt }],
        skipDuplicates: true,
      });
      return true;
    });
    if (changed) this.stats.transitions += 1;
  }

  /** Stores a PLC's reported state; a change of state is recorded once as an event. */
  private async setPlcState(plcId: string, state: string, at: Date, data: Record<string, unknown>): Promise<void> {
    await this.db.$transaction(async (tx) => {
      const before = await tx.plc.findUniqueOrThrow({ where: { id: plcId }, select: { edgeState: true } });
      await tx.plc.update({ where: { id: plcId }, data: { ...data, edgeState: state, edgeStateAt: at } });
      if (before.edgeState === state) return;
      await tx.plcEvent.createMany({
        data: [{ plcId, kind: "PLC_STATE", subject: "", fromValue: before.edgeState, toValue: state, at }],
        skipDuplicates: true,
      });
    });
  }

  /** Refreshes the stored last-seen time for a live message, at most every seenWriteMs. */
  private async touch(agentId: string, work: Work, key: string): Promise<void> {
    if (work.retained) return;
    const last = this.seenWrites.get(key) ?? 0;
    if (work.receivedAt.getTime() - last < this.seenWriteMs) return;
    this.seenWrites.set(key, work.receivedAt.getTime());
    await this.db.edgeAgent.update({ where: { id: agentId }, data: { lastSeenAt: work.receivedAt } });
  }
}
