import "server-only";
import { randomBytes } from "node:crypto";
import { request } from "node:https";
import { DomainError } from "@/lib/domain/errors";

/**
 * Client for the REST API of an OpenPLC Runtime v4 container (HTTPS, JWT).
 *
 * The runtime generates a self-signed certificate at start, so the certificate is not
 * verified. That is acceptable only because the API port is published on a loopback
 * address of the same host; the constructor refuses any other address.
 */

const LOOPBACK = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/;
const REQUEST_TIMEOUT_MS = 10_000;

export type PlcStatus = "RUNNING" | "STOPPED" | "EMPTY" | "ERROR" | "UNKNOWN";
export type CompilationStatus = { state: "COMPILING" | "SUCCESS" | "FAILED"; logs: string[] };

type Response = { status: number; body: string };

export class OpenPlcClient {
  private token: string | undefined;

  constructor(
    private readonly endpoint: { host: string; port: number },
    private readonly credentials: { username: string; password: string },
  ) {
    if (!LOOPBACK.test(endpoint.host)) {
      throw new DomainError("INVARIANT", "The OpenPLC API is only reached through a loopback address.", {
        rule: "api-loopback-only",
      });
    }
  }

  private send(method: string, path: string, headers: Record<string, string>, body?: Buffer): Promise<Response> {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          host: this.endpoint.host,
          port: this.endpoint.port,
          path: `/api/${path}`,
          method,
          headers: { ...headers, ...(body ? { "Content-Length": String(body.length) } : {}) },
          rejectUnauthorized: false,
          timeout: REQUEST_TIMEOUT_MS,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on("data", (chunk: Buffer) => chunks.push(chunk));
          res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") }));
        },
      );
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", reject);
      req.end(body);
    });
  }

  private async call(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) {
    try {
      return await this.send(method, path, headers, body);
    } catch {
      throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime did not answer.", { rule: "runtime-unreachable" });
    }
  }

  private static json(response: Response): Record<string, unknown> {
    try {
      const parsed: unknown = JSON.parse(response.body);
      return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  /** Runtime version; unauthenticated, so it doubles as the readiness probe. */
  async version(): Promise<string | undefined> {
    const response = await this.call("GET", "version");
    const version = OpenPlcClient.json(response).version;
    return response.status === 200 && typeof version === "string" ? version : undefined;
  }

  /** Creates the runtime's single API user on a fresh container; a no-op when it already exists. */
  async ensureUser(): Promise<void> {
    const body = Buffer.from(JSON.stringify({ ...this.credentials, role: "admin" }));
    const response = await this.call("POST", "create-user", { "Content-Type": "application/json" }, body);
    // 401/409: the first user already exists, which is the state we want.
    if (![201, 401, 409].includes(response.status)) {
      throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime rejected its API user.", {
        status: response.status,
      });
    }
  }

  private async login(): Promise<string> {
    const body = Buffer.from(JSON.stringify(this.credentials));
    const response = await this.call("POST", "login", { "Content-Type": "application/json" }, body);
    const token = OpenPlcClient.json(response).access_token;
    if (response.status !== 200 || typeof token !== "string") {
      throw new DomainError("RUNTIME_FAILURE", "Could not log in to the OpenPLC runtime.", { status: response.status });
    }
    return token;
  }

  private async authorized(method: string, path: string, headers: Record<string, string> = {}, body?: Buffer) {
    this.token ??= await this.login();
    let response = await this.call(method, path, { ...headers, Authorization: `Bearer ${this.token}` }, body);
    if (response.status === 401) {
      // The token expired or the container was recreated; log in once more.
      this.token = await this.login();
      response = await this.call(method, path, { ...headers, Authorization: `Bearer ${this.token}` }, body);
    }
    return response;
  }

  /** Uploads a program bundle; the runtime starts compiling it in the background. */
  async uploadProgram(zip: Uint8Array): Promise<void> {
    const boundary = `----zfactory${randomBytes(12).toString("hex")}`;
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="program.zip"\r\n` +
          "Content-Type: application/zip\r\n\r\n",
      ),
      Buffer.from(zip),
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const response = await this.authorized(
      "POST",
      "upload-file",
      { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    );
    const result = OpenPlcClient.json(response);
    if (response.status !== 200 || (typeof result.UploadFileFail === "string" && result.UploadFileFail !== "")) {
      throw new DomainError("RUNTIME_FAILURE", "The OpenPLC runtime rejected the program upload.", {
        status: response.status,
      });
    }
  }

  async compilationStatus(): Promise<CompilationStatus> {
    const result = OpenPlcClient.json(await this.authorized("GET", "compilation-status"));
    const logs = Array.isArray(result.logs) ? result.logs.map(String) : [];
    const status = String(result.status ?? "");
    if (status === "SUCCESS") return { state: "SUCCESS", logs };
    if (status === "FAILED" || status === "ERROR") return { state: "FAILED", logs };
    return { state: "COMPILING", logs };
  }

  private async command(path: string, expected: string, action: string): Promise<void> {
    const response = await this.authorized("GET", path);
    if (response.status !== 200 || OpenPlcClient.json(response).status !== expected) {
      throw new DomainError("RUNTIME_FAILURE", `The OpenPLC runtime could not ${action} the program.`, {
        status: response.status,
      });
    }
  }

  startPlc(): Promise<void> {
    return this.command("start-plc", "START:OK", "start");
  }

  stopPlc(): Promise<void> {
    return this.command("stop-plc", "STOP:OK", "stop");
  }

  async status(): Promise<PlcStatus> {
    const status = String(OpenPlcClient.json(await this.authorized("GET", "status")).status ?? "");
    const state = status.replace(/^STATUS:/, "");
    return state === "RUNNING" || state === "STOPPED" || state === "EMPTY" || state === "ERROR" ? state : "UNKNOWN";
  }
}
