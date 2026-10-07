import "server-only";
import { readFileSync } from "node:fs";
import { hostname } from "node:os";
import mqtt, { type IClientOptions, type MqttClient } from "mqtt";
import { INGEST_SUBSCRIPTIONS } from "@/lib/domain/agent-messages";
import type { PrismaClient } from "@/lib/generated/prisma/client";
import { type PipelineOptions, TelemetryPipeline, type TelemetryStats } from "@/lib/telemetry/pipeline";
import { PostgresTelemetryStore } from "@/lib/telemetry/store";
import { DYNSEC_RESPONSE_TOPIC, DynsecControl } from "./dynsec";
import { Ingestor, type IngestOptions, type IngestStats } from "./ingest";

/**
 * Web Factory's one broker connection per server process (TASK-902). It subscribes to what
 * agents publish and hands it to the ingestor, carries Dynamic Security administration,
 * and reconnects with a growing delay (1 s, doubling to 30 s; back to 1 s once connected). Browsers never get any of
 * this: pages read the database, and only the status below (no credential, no URL user)
 * is shown.
 */

export type MqttSettings = {
  url: string;
  username?: string;
  passwordFile?: string;
  caFile?: string;
  clientId?: string;
  /** How long the broker keeps Web Factory's session (and queues for it) while it is away. */
  sessionExpirySeconds?: number;
};

export type BrokerStatus = {
  configured: true;
  connected: boolean;
  broker: string;
  clientId: string;
  connects: number;
  disconnects: number;
  lastConnectedAt: string | null;
  lastDisconnectedAt: string | null;
  lastError: string | null;
  nextRetryMs: number;
  refusedSubscriptions: string[];
  ingest: IngestStats;
  telemetry: TelemetryStats;
};

export const MIN_RETRY_MS = 1_000;
export const MAX_RETRY_MS = 30_000;

/** The broker as it may be shown: scheme, host and port, never a user. */
export function redactBroker(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return "(unparsable)";
  }
}

export type Logger = (level: "info" | "warn" | "error", message: string, fields?: Record<string, unknown>) => void;

export class MqttRuntime {
  readonly client: MqttClient;
  readonly ingestor: Ingestor;
  readonly dynsec: DynsecControl;
  readonly telemetryStore: PostgresTelemetryStore;
  readonly telemetry: TelemetryPipeline;
  private readonly state = {
    connects: 0,
    disconnects: 0,
    lastConnectedAt: null as string | null,
    lastDisconnectedAt: null as string | null,
    lastError: null as string | null,
    refusedSubscriptions: [] as string[],
  };
  private readonly clientId: string;
  private up = false;
  private stopping = false;
  private retryMs = MIN_RETRY_MS;
  private retryTimer: NodeJS.Timeout | undefined;
  private readonly statsTimer: NodeJS.Timeout;
  private readonly maintenanceTimer: NodeJS.Timeout;

  constructor(
    private readonly settings: MqttSettings,
    db: PrismaClient,
    private readonly log: Logger,
    ingestOptions: IngestOptions = {},
    telemetryOptions: PipelineOptions = {},
  ) {
    // A stable client id: the broker keeps this session, and what agents publish meanwhile.
    this.clientId = settings.clientId ?? `web-factory-${hostname()}`;
    this.telemetryStore = new PostgresTelemetryStore(db);
    this.telemetry = new TelemetryPipeline(db, this.telemetryStore, {
      ...telemetryOptions,
      onError: (error) => {
        log("error", "telemetry write failed", { error: error instanceof Error ? error.message : "unknown" });
        telemetryOptions.onError?.(error);
      },
    });
    const retentionDays = telemetryOptions.retentionDays ?? 30;
    this.ingestor = new Ingestor(db, {
      telemetry: this.telemetry,
      ...ingestOptions,
      onError: (error, key) => {
        log("error", "ingest failed", { agent: key, error: error instanceof Error ? error.name : "unknown" });
        ingestOptions.onError?.(error, key);
      },
    });
    this.dynsec = new DynsecControl((topic, payload) => this.publish(topic, payload));

    const options: IClientOptions = {
      clientId: this.clientId,
      protocolVersion: 5,
      // A persistent session (TASK-903): while Web Factory is away, the broker queues what
      // agents publish with QoS 1, telemetry above all, and delivers it on reconnecting.
      // Subscribing again on every connect also brings the retained state.
      clean: false,
      properties: { sessionExpiryInterval: settings.sessionExpirySeconds ?? 86_400 },
      keepalive: 30,
      connectTimeout: 10_000,
      // Reconnects are scheduled here, with a growing delay (MQTT.js retries at a fixed one).
      reconnectPeriod: 0,
      resubscribe: false,
    };
    if (settings.username) options.username = settings.username;
    if (settings.passwordFile) options.password = readFileSync(settings.passwordFile, "utf8").replace(/\r?\n$/, "");
    if (settings.caFile) options.ca = readFileSync(settings.caFile);
    options.rejectUnauthorized = true;

    this.client = mqtt.connect(settings.url, options);
    this.client.on("connect", () => void this.connected());
    this.client.on("close", () => this.closed());
    this.client.on("error", (error) => {
      this.state.lastError = error.message;
      log("warn", "broker error", { error: error.message });
    });
    this.client.on("message", (topic, payload, packet) => {
      if (topic === DYNSEC_RESPONSE_TOPIC) this.dynsec.onResponse(payload);
      else this.ingestor.handle(topic, payload, packet.retain);
    });
    log("info", "connecting to the broker", { broker: redactBroker(settings.url), clientId: this.clientId });
    // For operators: one line a minute with the connection, ingest and telemetry counters.
    this.statsTimer = setInterval(() => {
      const { ingest, telemetry, ...connection } = this.status();
      log("info", "broker stats", { ...connection, ingest, telemetry });
    }, 60_000);
    this.statsTimer.unref();
    // Telemetry partitions: today's and tomorrow's ready, those past the retention dropped.
    const maintain = () =>
      this.telemetryStore
        .maintain(new Date(), retentionDays)
        .then(({ created, dropped }) => {
          if (created.length > 0 || dropped.length > 0) log("info", "telemetry partitions", { created, dropped });
        })
        .catch((error: unknown) =>
          log("error", "telemetry maintenance failed", { error: error instanceof Error ? error.message : "unknown" }),
        );
    void maintain();
    this.maintenanceTimer = setInterval(() => void maintain(), 3_600_000);
    this.maintenanceTimer.unref();
  }

  private async connected(): Promise<void> {
    this.up = true;
    this.state.connects += 1;
    this.state.lastConnectedAt = new Date().toISOString();
    this.state.lastError = null;
    this.retryMs = MIN_RETRY_MS;
    this.log("info", "broker connected", { broker: redactBroker(this.settings.url), connects: this.state.connects });
    const refused: string[] = [];
    for (const topic of [...INGEST_SUBSCRIPTIONS, DYNSEC_RESPONSE_TOPIC]) {
      try {
        const granted = await this.client.subscribeAsync(topic, { qos: 1 });
        if (granted.some((grant) => grant.qos > 2)) refused.push(topic);
      } catch {
        refused.push(topic);
      }
    }
    this.state.refusedSubscriptions = refused;
    if (refused.length > 0) {
      this.state.lastError = `subscriptions refused: ${refused.join(", ")}`;
      this.log("error", "broker refused subscriptions", { topics: refused });
    }
  }

  private closed(): void {
    this.dynsec.failAll("the broker connection closed");
    if (this.up) {
      this.up = false;
      this.state.disconnects += 1;
      this.state.lastDisconnectedAt = new Date().toISOString();
      this.log("warn", "broker connection lost", { broker: redactBroker(this.settings.url) });
    }
    if (this.stopping || this.retryTimer) return;
    const delay = this.retryMs;
    // Authorization failures are retried too: an administrator may fix the account.
    this.retryMs = Math.min(MAX_RETRY_MS, this.retryMs * 2);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      if (!this.stopping) this.client.reconnect();
    }, delay);
    this.retryTimer.unref();
  }

  async publish(topic: string, payload: string): Promise<void> {
    if (!this.client.connected) throw new Error("not connected to the broker");
    await this.client.publishAsync(topic, payload, { qos: 1 });
  }

  status(): BrokerStatus {
    return {
      configured: true,
      connected: this.client.connected,
      broker: redactBroker(this.settings.url),
      clientId: this.clientId,
      connects: this.state.connects,
      disconnects: this.state.disconnects,
      lastConnectedAt: this.state.lastConnectedAt,
      lastDisconnectedAt: this.state.lastDisconnectedAt,
      lastError: this.state.lastError,
      nextRetryMs: this.retryMs,
      refusedSubscriptions: this.state.refusedSubscriptions,
      ingest: this.ingestor.stats,
      telemetry: this.telemetry.stats,
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.statsTimer);
    clearInterval(this.maintenanceTimer);
    await this.ingestor.idle();
    await this.telemetry.stop();
    await this.client.endAsync();
  }
}
