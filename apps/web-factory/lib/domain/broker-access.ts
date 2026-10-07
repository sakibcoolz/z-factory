import { agentTopicRoot } from "./agent-messages";

/**
 * What one agent may do on the broker (TASK-902, ADR-0019). Every agent gets its own
 * Mosquitto Dynamic Security client and role; the role allows only the agent's own topics:
 * publishing what it reports, subscribing to its commands. Everything else is refused by
 * the broker (default deny on publish and subscribe). Pure; importable anywhere.
 */

export type BrokerAcl = {
  acltype: "publishClientSend" | "publishClientReceive" | "subscribePattern" | "unsubscribePattern";
  topic: string;
  allow: boolean;
};

export type AgentBrokerIdentity = {
  username: string;
  /** The agent's default MQTT client id (zfactory-agent-<site>-<agent>); the client is bound to it. */
  clientId: string;
  rolename: string;
  acls: BrokerAcl[];
};

export function agentBrokerIdentity(siteKey: string, agentKey: string): AgentBrokerIdentity {
  const root = agentTopicRoot(siteKey, agentKey);
  const send = (topic: string): BrokerAcl => ({ acltype: "publishClientSend", topic: `${root}/${topic}`, allow: true });
  return {
    // ':' cannot appear in a site or agent id, so two agents never share a user name.
    username: `agent:${siteKey}:${agentKey}`,
    clientId: `zfactory-agent-${siteKey}-${agentKey}`,
    rolename: `zfactory-agent:${siteKey}:${agentKey}`,
    acls: [
      send("telemetry/+"),
      send("state/+"),
      send("ack/+"),
      send("agent/heartbeat"),
      // Also the will: the broker checks it when the agent connects.
      send("agent/status"),
      { acltype: "subscribePattern", topic: `${root}/command/+`, allow: true },
      { acltype: "unsubscribePattern", topic: `${root}/command/+`, allow: true },
    ],
  };
}
