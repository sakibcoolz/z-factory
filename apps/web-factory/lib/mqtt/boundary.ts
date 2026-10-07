import "server-only";
import { getDb } from "@/lib/db/client";
import { DEFAULT_LIMITS, type ConnectivityLimits } from "@/lib/domain/connectivity";
import { getServerEnv } from "@/lib/env";
import { log } from "@/lib/log";
import type { BrokerAdmin } from "./dynsec";
import { type BrokerStatus, MqttRuntime, type MqttSettings } from "./runtime";

/**
 * The server-only MQTT boundary. Web Factory is the only party that talks to the broker on
 * behalf of browsers: no page, component or route ever hands the broker URL's credentials,
 * the password file or a broker connection to a browser. Topics follow the agents'
 * contract: zfactory/{siteKey}/{agentKey}/… (lib/domain/agent-messages.ts).
 */

/** The broker settings, or null when MQTT is not configured. */
export function mqttSettings(): MqttSettings | null {
  const env = getServerEnv();
  if (!env.WEB_FACTORY_MQTT_URL) return null;
  return {
    url: env.WEB_FACTORY_MQTT_URL,
    username: env.WEB_FACTORY_MQTT_USERNAME,
    passwordFile: env.WEB_FACTORY_MQTT_PASSWORD_FILE,
    caFile: env.WEB_FACTORY_MQTT_CA_FILE,
    clientId: env.WEB_FACTORY_MQTT_CLIENT_ID,
  };
}

// One connection per server process; survives dev hot reloads.
const globalForMqtt = globalThis as typeof globalThis & { webFactoryMqtt?: MqttRuntime };

/** The running broker connection, started on first use; null when MQTT is not configured. */
export function getMqttRuntime(): MqttRuntime | null {
  if (globalForMqtt.webFactoryMqtt) return globalForMqtt.webFactoryMqtt;
  const settings = mqttSettings();
  if (!settings) return null;
  globalForMqtt.webFactoryMqtt = new MqttRuntime(settings, getDb(), log);
  return globalForMqtt.webFactoryMqtt;
}

/** Dynamic Security administration over the broker connection, or null without MQTT. */
export function getBrokerAdmin(): BrokerAdmin | null {
  return getMqttRuntime()?.dynsec ?? null;
}

export function brokerStatus(): BrokerStatus | { configured: false } {
  return getMqttRuntime()?.status() ?? { configured: false };
}

/** Forgets what the ingestor remembers about an agent whose credentials changed. */
export function forgetAgent(siteKey: string, agentKey: string): void {
  globalForMqtt.webFactoryMqtt?.ingestor.forget(siteKey, agentKey);
}

export function connectivityLimits(): ConnectivityLimits {
  const seconds = getServerEnv().WEB_FACTORY_AGENT_HEARTBEAT_S;
  return seconds ? { heartbeatMs: seconds * 1000 } : DEFAULT_LIMITS;
}

/** The broker URL agents are told to use (it may differ from Web Factory's own). */
export function agentBrokerUrl(): string | null {
  const env = getServerEnv();
  return env.WEB_FACTORY_MQTT_AGENT_URL ?? env.WEB_FACTORY_MQTT_URL ?? null;
}
