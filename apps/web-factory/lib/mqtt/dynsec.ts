import "server-only";
import { randomUUID } from "node:crypto";
import type { AgentBrokerIdentity } from "@/lib/domain/broker-access";

/**
 * Mosquitto Dynamic Security, administered over the broker connection (TASK-902). Commands
 * go to $CONTROL/dynamic-security/v1 and the answers come back on …/response, matched by
 * correlation data. Passwords travel in these commands, so in production the broker
 * connection is TLS (mqtts://); they are never logged or stored.
 */

export const DYNSEC_TOPIC = "$CONTROL/dynamic-security/v1";
export const DYNSEC_RESPONSE_TOPIC = `${DYNSEC_TOPIC}/response`;
/** Web Factory's own role: publishing commands to agents (TASK-905). */
export const SERVICE_ROLE = "web-factory-commands";

/** What onboarding needs from the broker; tests use a fake. */
export interface BrokerAdmin {
  /** Creates or resets the agent's role and client; the password replaces any earlier one. */
  ensureAgentClient(identity: AgentBrokerIdentity, password: string): Promise<void>;
  /** Disables the client and ends its connection; a client that does not exist is fine. */
  disableClient(username: string): Promise<void>;
}

export class BrokerUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BrokerUnavailableError";
  }
}

export class DynsecCommandError extends Error {
  constructor(
    readonly command: string,
    readonly reason: string,
  ) {
    super(`${command}: ${reason}`);
    this.name = "DynsecCommandError";
  }
}

type Command = { command: string; [key: string]: unknown };
type Response = { command: string; error?: string; data?: unknown; correlationData?: string };
type Pending = { resolve: (responses: Response[]) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

export class DynsecControl implements BrokerAdmin {
  private readonly pending = new Map<string, Pending>();

  constructor(
    /** Publishes on the broker connection; rejects when it is down. */
    private readonly publish: (topic: string, payload: string) => Promise<void>,
    private readonly timeoutMs = 5000,
  ) {}

  /** Hands an answer from the response topic to the request waiting for it. */
  onResponse(payload: Buffer): void {
    let responses: Response[];
    try {
      responses = (JSON.parse(payload.toString("utf8")) as { responses?: Response[] }).responses ?? [];
    } catch {
      return;
    }
    const id = responses[0]?.correlationData?.split("#")[0];
    const waiting = id ? this.pending.get(id) : undefined;
    if (!id || !waiting) return;
    this.pending.delete(id);
    clearTimeout(waiting.timer);
    waiting.resolve(responses);
  }

  /** Fails every request in flight, e.g. when the connection goes. */
  failAll(reason: string): void {
    for (const [id, waiting] of this.pending) {
      clearTimeout(waiting.timer);
      waiting.reject(new BrokerUnavailableError(reason));
      this.pending.delete(id);
    }
  }

  async run(commands: Command[]): Promise<Response[]> {
    const id = randomUUID();
    const tagged = commands.map((command, index) => ({ ...command, correlationData: `${id}#${index}` }));
    const answer = new Promise<Response[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BrokerUnavailableError("the broker did not answer"));
      }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
    });
    try {
      await this.publish(DYNSEC_TOPIC, JSON.stringify({ commands: tagged }));
    } catch (error) {
      const waiting = this.pending.get(id);
      if (waiting) clearTimeout(waiting.timer);
      this.pending.delete(id);
      throw new BrokerUnavailableError(error instanceof Error ? error.message : "publishing failed");
    }
    return answer;
  }

  private async one(command: Command, tolerated: string[] = []): Promise<Response> {
    const [response] = await this.run([command]);
    if (!response) throw new DynsecCommandError(command.command, "no response");
    if (response.error && !tolerated.includes(response.error)) {
      throw new DynsecCommandError(command.command, response.error);
    }
    return response;
  }

  async ensureAgentClient(identity: AgentBrokerIdentity, password: string): Promise<void> {
    const { username, clientId, rolename, acls } = identity;
    const role = await this.one({ command: "createRole", rolename, acls }, ["Role already exists"]);
    if (role.error) await this.one({ command: "modifyRole", rolename, acls });
    const client = await this.one(
      { command: "createClient", username, password, clientid: clientId, roles: [{ rolename }] },
      ["Client already exists"],
    );
    if (client.error) {
      await this.one({ command: "modifyClient", username, password, clientid: clientId, roles: [{ rolename }] });
      // Ends a connection made with the old password, then lets the new one in.
      await this.one({ command: "disableClient", username });
      await this.one({ command: "enableClient", username });
    }
  }

  /**
   * Gives Web Factory's own client the right to publish commands, and nothing more
   * (TASK-905): the role `web-factory-commands` allows publishing to every agent's
   * command topic. Repeating it changes nothing. Returns whether something changed:
   * then the broker disconnects the client (an "administrative action") and the next
   * connection has the right.
   */
  async ensureServiceRole(username: string): Promise<boolean> {
    const rolename = SERVICE_ROLE;
    const acls = [{ acltype: "publishClientSend", topic: "zfactory/+/+/command/+", allow: true }];
    const role = await this.one({ command: "createRole", rolename, acls }, ["Role already exists"]);
    if (role.error) {
      // Changing a role disconnects every client that holds it, this one too: only when it differs.
      const current = await this.one({ command: "getRole", rolename });
      const held = (
        (current.data as { role?: { acls?: Array<{ acltype: string; topic: string; allow: boolean }> } })?.role?.acls ??
        []
      ).map((acl) => `${acl.acltype} ${acl.topic} ${acl.allow}`);
      const wanted = acls.map((acl) => `${acl.acltype} ${acl.topic} ${acl.allow}`);
      if (held.sort().join("|") !== wanted.sort().join("|")) {
        await this.one({ command: "modifyRole", rolename, acls });
        return true;
      }
    }
    const client = await this.one({ command: "getClient", username });
    const roles = (
      (client.data as { client?: { roles?: Array<{ rolename: string }> } } | undefined)?.client?.roles ?? []
    ).map((entry) => entry.rolename);
    if (roles.includes(rolename)) return false;
    await this.one({ command: "addClientRole", username, rolename });
    return true;
  }

  async disableClient(username: string): Promise<void> {
    await this.one({ command: "disableClient", username }, ["Client not found"]);
  }
}
