import "server-only";
import { getServerEnv } from "@/lib/env";

/**
 * The server-only MQTT boundary (TASK-901; the client itself is TASK-902). Web Factory is
 * the only party that talks to the broker on behalf of browsers: no page, component or
 * route ever hands the broker URL's credentials, the password file or a broker connection
 * to a browser. Topics follow the agents' contract: zfactory/{siteKey}/{agentKey}/….
 */

export type MqttSettings = {
  url: string;
  username?: string;
  passwordFile?: string;
  caFile?: string;
};

/** The broker settings, or null when MQTT is not configured yet. */
export function mqttSettings(): MqttSettings | null {
  const env = getServerEnv();
  if (!env.WEB_FACTORY_MQTT_URL) return null;
  return {
    url: env.WEB_FACTORY_MQTT_URL,
    username: env.WEB_FACTORY_MQTT_USERNAME,
    passwordFile: env.WEB_FACTORY_MQTT_PASSWORD_FILE,
    caFile: env.WEB_FACTORY_MQTT_CA_FILE,
  };
}

/** The topic root of an agent: what it publishes under and what commands go to. */
export function agentTopicRoot(siteKey: string, agentKey: string): string {
  const segment = /^[A-Za-z0-9_-]{1,64}$/;
  if (!segment.test(siteKey) || !segment.test(agentKey)) throw new Error("not an MQTT topic segment");
  return `zfactory/${siteKey}/${agentKey}`;
}
